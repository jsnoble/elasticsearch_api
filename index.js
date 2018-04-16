'use strict';

const Promise = require('bluebird');
const _ = require('lodash');
const parseError = require('error_parser');
const DOCUMENT_EXISTS = 409;

// Module to manage persistence in Elasticsearch.
// All functions in this module return promises that must be resolved to get the final result.
module.exports = function(client, logger, _opConfig) {
    const warning = _warn(logger, 'The elasticsearch cluster queues are overloaded, resubmitting failed queries from bulk');
    let config = _opConfig ? _opConfig : {};


    function count(query) {
        query.size = 0;
        return _searchES(query)
            .then(data => data.hits.total);
    }

    function search(query) {
        return _searchES(query)
            .then(data => {
                if (config.full_response) {
                    return data
                }
                else {
                    return _.map(data.hits.hits, (doc) => doc._source);
                }
            });
    }

    function makeRequest(clientBase, endpoint, query, resolver) {
        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(runRequest, query, reject, logger);

            function runRequest() {
                clientBase[endpoint](query)
                    .then(result => resolve(result))
                    .catch(errHandler);
            }

            runRequest();
        });
    }

    function clientRequest(endpoint, query, resolver) {
        return makeRequest(client, endpoint, query, resolver)
    }

    function clientIndicesRequest(endpoint, query, resolver) {
        return makeRequest(client.indices, endpoint, query, resolver)
    }

    function mget(query) {
        return clientRequest('mget', query);
    }

    function get(query) {
        return clientRequest('get', query)
            .then(result => result._source);
    }

    function index(query) {
        return clientRequest('index', query);
    }

    function indexWithId(query) {
        return clientRequest('index', query)
            .then(result => query.body);
    }

    function create(query) {
        return clientRequest('create', query)
            .then(result => query.body);
    }

    function update(query) {
        return clientRequest('update', query)
            .then(result => query.body.doc);
    }

    function remove(query) {
        return clientRequest('delete', query)
            .then(result => result.found);
    }

    function indexExists(query) {
        return clientIndicesRequest('exists', query);
    }

    function indexCreate(query) {
        return clientIndicesRequest('create', query);
    }

    function indexRefresh(query) {
        return clientIndicesRequest('refresh', query);
    }

    function indexRecovery(query) {
        return clientIndicesRequest('recovery', query);
    }

    function nodeInfo() {
        return client.nodes.info();
    }

    function nodeStats() {
        return client.nodes.stats()
    }

    function compareNames(_name, key){
        const name = _name.replace(/\*/g, '.*');
        const fullNameRegex = RegExp(name, 'g');
        if (key.match(fullNameRegex) !== null) return true;
        // a name may come in as es_d*:2017-domains* so we need to parse and compare 2017-domains*
        // against the index names listed
        if (name.includes(':')) {
            const clusterName = name.split(':')[1];
            if (key.match(RegExp(clusterName), 'g') !== null) {
                return true;
            }
        }
        return false;
    }

    function verifyIndex(indexObj, name) {
        var wasFound = false;
        var results = [];

        //exact match of index
        if (indexObj[name]) {
            wasFound = true;
            let windowSize = indexObj[name].settings.index.max_result_window ? indexObj[name].settings.index.max_result_window : 10000;
            results.push({name: name, windowSize: windowSize})
        }
        else {
            //check to see if regex picks up indices
            _.forOwn(indexObj, function(value, key) {
                if (compareNames(name, key)) {
                    wasFound = true;
                    let windowSize = value.settings.index.max_result_window ? value.settings.index.max_result_window : 10000;
                    results.push({name: key, windowSize: windowSize})
                }
            });
        }

        return {found: wasFound, indexWindowSize: results}
    }

    function version() {
        return client.cluster.stats({})
            .then(function(data) {
                var version = data.nodes.versions[0];

                if (_checkVersion(version)) {
                    return client.indices.getSettings({})
                        .then(function(results) {
                            var index = verifyIndex(results, config.index);
                            if (index.found) {
                                index.indexWindowSize.forEach(function(ind) {
                                    logger.warn(`max_result_window for index: ${ind.name} is set at ${ind.windowSize} . On very large indices it is possible that a slice can not be divided to stay below this limit. If that occurs an error will be thrown by Elasticsearch and the slice can not be processed. Increasing max_result_window in the Elasticsearch index settings will resolve the problem.`);
                                })
                            }
                            else {
                                return Promise.reject('index specified in reader does not exist')
                            }
                        }).catch(function(err) {
                            var errMsg = parseError(err);
                            logger.error(errMsg);
                            return Promise.reject(errMsg)
                        })
                }
            });
    }


    function putTemplate(template, name) {
        return client.indices.putTemplate({body: template, name: name})
            .then(function(results) {
                return results
            })
            .catch(function(err) {
                var errMsg = parseError(err);
                return Promise.reject(errMsg)
            })
    }

    function bulkSend(data) {
        let retryTimer = {start: 5000, limit: 10000};

        return new Promise(function(resolve, reject) {
            function sendData(data) {
                client.bulk({body: data})
                    .then(function(results) {
                        if (results.errors) {
                            var response = _filterResponse(data, results);

                            if (response.error) {
                                reject(response.reason)
                            }
                            else {
                                //may get doc already created error, if so just return
                                if (response.data.length === 0) {
                                    resolve(results)
                                }
                                else {
                                    warning();
                                    retry(retryTimer, sendData, response.data);
                                }
                            }
                        }
                        else {
                            resolve(results)
                        }
                    })
                    .catch(function(err) {
                        var errMsg = parseError(err);
                        logger.error(`bulk sender error: ${errMsg}`);
                        reject(`bulk sender error: ${errMsg}`);
                    })
            }

            sendData(data);
        });
    }

    function _warn(logger, msg) {
        return _.throttle(() => logger.warn(msg), 5000);
    }

    /*
     * These range query functions do not belong in this module.
     */
    function _buildRangeQuery(opConfig, msg) {
        var body = {
            query: {
                bool: {
                    must: []
                }
            }
        };
        // is a range type query
        if (msg.start && msg.end) {
            var dateObj = {};
            var date_field_name = opConfig.date_field_name;

            dateObj[date_field_name] = {
                gte: msg.start,
                lt: msg.end
            };

            body.query.bool.must.push({range: dateObj});
        }

        //elasticsearch _id based query
        if (msg.key) {
            body.query.bool.must.push({wildcard: {_uid: msg.key}})
        }

        //elasticsearch lucene based query
        if (opConfig.query) {
            body.query.bool.must.push({
                query_string: {
                    query: opConfig.query
                }
            })
        }

        return body;
    }

    function buildQuery(opConfig, msg) {

        var query = {
            index: opConfig.index,
            size: msg.count,
            body: _buildRangeQuery(opConfig, msg)
        };

        if (opConfig.fields) {
            query._source = opConfig.fields;
        }

        return query;
    }

    function _filterResponse(data, results) {
        const retry = [];
        const items = results.items;
        let nonRetriableError = false;
        let reason = '';

        for (let i = 0; i < items.length; i += 1) {
            //key could either be create or delete etc, just want the actual data at the value spot
            const item = _.values(items[i])[0];
            if (item.error) {
                // On a create request if a document exists it's not an error.
                // are there cases where this is incorrect?
                if (item.status === DOCUMENT_EXISTS) {
                    continue;
                }

                if (item.error.type === 'es_rejected_execution_exception') {
                    if (i === 0) {
                        retry.push(data[0], data[1])
                    }
                    else {
                        retry.push(data[i * 2], data[i * 2 + 1])
                    }
                }
                else {
                    if (item.error.type !== 'document_already_exists_exception' && item.error.type !== 'document_missing_exception') {
                        nonRetriableError = true;
                        reason = `${item.error.type}--${item.error.reason}`;
                        break;
                    }
                }
            }
        }

        if (nonRetriableError) {
            return {data: [], error: nonRetriableError, reason: reason};
        }

        return {data: retry, error: false};
    }

    function _searchES(query) {
        return new Promise((resolve, reject) => {
            const errHandler = _errorHandler(_performSearch, query, reject, logger);
            const retry = retryFn(_searchES, query);

            function _performSearch(queryParam) {
                client.search(queryParam)
                    .then(function(data) {
                        if (data._shards.failed > 0) {
                            const reasons = _.uniq(_.flatMap(data._shards.failures, (shard) => shard.reason.type));

                            if (reasons.length > 1 || reasons[0] !== 'es_rejected_execution_exception') {
                                const errorReason = reasons.join(' | ');
                                logger.error('Not all shards returned successful, shard errors: ', errorReason);
                                reject(errorReason)
                            }
                            else {
                                retry()
                            }
                        }
                        else {
                            resolve(data)
                        }
                    })
                    .catch(errHandler);
            }

            _performSearch(query)
        })
    }

    function retryFn(fn, data) {
        let retryTimer = {start: 5000, limit: 10000};

        return () => {
            let timer = Math.floor(Math.random() * (retryTimer.limit - retryTimer.start) + retryTimer.start);

            if (retryTimer.limit < 60000) {
                retryTimer.limit += 10000
            }
            if (retryTimer.start < 30000) {
                retryTimer.start += 5000
            }
            setTimeout(function() {
                fn(data);
            }, timer);
        }
    }


    function _errorHandler(fn, data, reject, logger) {
        const retry = retryFn(fn, data);
        return function(err) {
            const isRejectedError = _.get(err, 'body.error.type') === 'es_rejected_execution_exception';
            const isConnectionError = _.get(err, 'message') === 'No Living connections';
            if (isRejectedError) {
                // this iteration we will not handle with no living connections issue
                retry()
            }
            else {
                const errMsg = `invoking elasticsearch_api ${fn.name} resulted in a runtime error: ${parseError(err)}`;
                logger.error(errMsg);
                reject(errMsg)
            }
        }
    }

    function _checkVersion(str) {
        var num = Number(str.replace(/\./g, ''));
        return num >= 210;
    }

    return {
        search: search,
        count: count,
        get: get,
        index: index,
        indexWithId: indexWithId,
        create: create,
        update: update,
        remove: remove,
        version: version,
        putTemplate: putTemplate,
        bulkSend: bulkSend,
        nodeInfo: nodeInfo,
        nodeStats: nodeStats,
        buildQuery: buildQuery,
        indexExists: indexExists,
        indexCreate: indexCreate,
        indexRefresh: indexRefresh,
        indexRecovery: indexRecovery,
        // The APIs below are deprecated and should be removed.
        index_exists: indexExists,
        index_create: indexCreate,
        index_refresh: indexRefresh,
        index_recovery: indexRecovery
    };
};