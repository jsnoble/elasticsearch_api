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

    function get(query) {
        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(getRecord, query, reject, logger);

            function getRecord() {
                client.get(query)
                    .then(function(result) {
                        resolve(result._source)
                    })
                    .catch(errHandler);
            }

            getRecord();
        })
    }

    function index(query) {
        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(indexRecord, query, reject, logger);

            function indexRecord() {
                client.index(query)
                    .then(function(result) {
                        resolve(result);
                    })
                    .catch(errHandler);
            }

            indexRecord();
        })
    }

    function indexWithId(query) {
        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(indexRecordID, query, reject, logger);

            function indexRecordID() {
                client.index(query)
                    .then(function(result) {
                        resolve(query.body);
                    })
                    .catch(errHandler);
            }

            indexRecordID();
        })
    }

    function create(query) {
        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(createRecord, query, reject, logger);

            function createRecord() {
                client.create(query)
                    .then(function(result) {
                        resolve(query.body);
                    })
                    .catch(errHandler);
            }

            createRecord();
        })
    }


    function update(query) {
        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(updateRecord, query, reject, logger);

            function updateRecord() {
                client.update(query)
                    .then(function(result) {
                        resolve(query.body.doc);
                    })
                    .catch(errHandler);
            }

            updateRecord();
        })
    }

    function remove(query) {
        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(removeRecord, query, reject, logger);

            function removeRecord() {
                client.delete(query)
                    .then(function(result) {
                        resolve(result.found);
                    })
                    .catch(errHandler);
            }

            removeRecord();
        });
    }

    function verifyIndex(indexObj, name) {
        var wasFound = false;
        var results = [];
        var regex = RegExp(name);

        //exact match of index
        if (indexObj[name]) {
            wasFound = true;
            let windowSize = indexObj[name].settings.index.max_result_window ? indexObj[name].settings.index.max_result_window : 10000;
            results.push({name: name, windowSize: windowSize})
        }
        else {
            //check to see if regex picks up indices
            _.forOwn(indexObj, function(value, key) {
                if (key.match(regex) !== null) {
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

    function nodeInfo() {
        return client.nodes.info();
    }

    function nodeStats() {
        return client.nodes.stats()
    }


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

    function index_exists(query) {

        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(exists, query, reject, logger);

            function exists() {
                client.indices.exists(query)
                    .then(function(results) {
                        resolve(results);
                    })
                    .catch(errHandler);
            }

            exists();
        })
    }

    function index_create(query) {

        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(indexCreate, query, reject, logger);

            function indexCreate() {
                client.indices.create(query)
                    .then(function(results) {
                        resolve(results);
                    })
                    .catch(errHandler);
            }

            indexCreate();
        })
    }

    function index_refresh(query) {

        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(indexRefresh, query, reject, logger);

            function indexRefresh() {
                client.indices.refresh(query)
                    .then(function(results) {
                        resolve(results);
                    })
                    .catch(errHandler);
            }

            indexRefresh();
        })
    }

    function index_recovery(query) {

        return new Promise(function(resolve, reject) {
            var errHandler = _errorHandler(indexRecovery, query, reject, logger);

            function indexRecovery() {
                client.indices.recovery(query)
                    .then(function(results) {
                        resolve(results);
                    })
                    .catch(errHandler);
            }

            indexRecovery();
        })
    }

    function _warn(logger, msg) {
        return _.throttle(() => logger.warn(msg), 5000);
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

    function _canRetry(err){
        const isRejectedError = _.get(err, 'body.error.type') === 'es_rejected_execution_exception';
        const isConnectionError = _.get(err, 'message') === 'No Living connections';
        return isRejectedError || isConnectionError
    }

    function _errorHandler(fn, data, reject, logger) {
        const retry = retryFn(fn, data);
        return function(err) {
            if (_canRetry(err)) {
                retry()
            }
            else {
                console.log('what is the error here', err);
                var errMsg = `invoking elasticsearch_api ${fn.name} resulted in a runtime error: ${parseError(err)}`;
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
        index_exists: index_exists,
        index_create: index_create,
        index_refresh: index_refresh,
        index_recovery: index_recovery
    };
};