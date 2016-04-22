var _MtpApiManager = (function () {
    var cachedNetworkers = {},
        cachedUploadNetworkers = {},
        cachedExportPromise = {},
        baseDcID = false;

    var telegramMeNotified;

    _MtpSingleInstanceService.start();

    _Storage.get('dc').then(function (dcID) {
        if (dcID) {
            baseDcID = dcID;
        }
    });

    function telegramMeNotify(newValue) {
        if (telegramMeNotified !== newValue) {
            telegramMeNotified = newValue;
            _TelegramMeWebService.setAuthorized(telegramMeNotified);
        }
    }

    function mtpSetUserAuth(dcID, userAuth) {
        var fullUserAuth = angular.extend({dcID: dcID}, userAuth);
        _Storage.set({
            dc: dcID,
            user_auth: fullUserAuth
        });
        telegramMeNotify(true);
        $rootScope.$broadcast('user_auth', fullUserAuth);

        baseDcID = dcID;
    }

    function mtpLogOut() {
        var storageKeys = [];
        for (var dcID = 1; dcID <= 5; dcID++) {
            storageKeys.push('dc' + dcID + '_auth_key');
        }
        return _Storage.get.apply(_Storage, storageKeys).then(function (storageResult) {
            var logoutPromises = [];
            for (var i = 0; i < storageResult.length; i++) {
                if (storageResult[i]) {
                    logoutPromises.push(mtpInvokeApi('auth.logOut', {}, {dcID: i + 1}));
                }
            }
            return $q.all(logoutPromises).then(function () {
                _Storage.remove('dc', 'user_auth');
                baseDcID = false;
                telegramMeNotify(false);
            }, function (error) {
                _Storage.remove.apply(storageKeys);
                _Storage.remove('dc', 'user_auth');
                baseDcID = false;
                error.handled = true;
                telegramMeNotify(false);
            });
        });
    }

    function mtpGetNetworker(dcID, options) {
        options = options || {};

        var cache = (options.fileUpload || options.fileDownload)
            ? cachedUploadNetworkers
            : cachedNetworkers;
        if (!dcID) {
            throw new Exception('get Networker without dcID');
        }

        if (cache[dcID] !== undefined) {
            return _qSync.when(cache[dcID]);
        }

        var akk = 'dc' + dcID + '_auth_key',
            ssk = 'dc' + dcID + '_server_salt';

        return _Storage.get(akk, ssk).then(function (result) {

            if (cache[dcID] !== undefined) {
                return cache[dcID];
            }

            var authKeyHex = result[0],
                serverSaltHex = result[1];
            // console.log('ass', dcID, authKeyHex, serverSaltHex);
            if (authKeyHex && authKeyHex.length == 512) {
                var authKey = bytesFromHex(authKeyHex);
                var serverSalt = bytesFromHex(serverSaltHex);

                return cache[dcID] = _MtpNetworkerFactory.getNetworker(dcID, authKey, serverSalt, options);
            }

            if (!options.createNetworker) {
                return $q.reject({type: 'AUTH_KEY_EMPTY', code: 401});
            }

            return _MtpAuthorizer.auth(dcID).then(function (auth) {
                var storeObj = {};
                storeObj[akk] = bytesToHex(auth.authKey);
                storeObj[ssk] = bytesToHex(auth.serverSalt);
                _Storage.set(storeObj);

                return cache[dcID] = _MtpNetworkerFactory.getNetworker(dcID, auth.authKey, auth.serverSalt, options);
            }, function (error) {
                console.log('Get networker error', error, error.stack);
                return $q.reject(error);
            });
        });
    };

    function mtpInvokeApi(method, params, options) {
        options = options || {};

        var deferred = $q.defer(),
            rejectPromise = function (error) {
                if (!error) {
                    error = {type: 'ERROR_EMPTY'};
                } else if (!angular.isObject(error)) {
                    error = {message: error};
                }
                deferred.reject(error);

                if (!options.noErrorBox) {
                    error.input = method;
                    error.stack = error.originalError && error.originalError.stack || error.stack || (new Error()).stack;
                    setTimeout(function () {
                        if (!error.handled) {
                            if (error.code == 401) {
                                mtpLogOut()['finally'](function () {
                                    if (location.protocol == 'http:' && !Config.Modes.http &&
                                        Config.App.domains.indexOf(location.hostname) != -1) {
                                        location.href = location.href.replace(/^http:/, 'https:');
                                    } else {
                                        location.hash = '/login';
                                        _AppRuntimeManager.reload();
                                    }
                                });
                            } else {
                                ErrorService.show({error: error});
                            }
                            error.handled = true;
                        }
                    }, 100);
                }
            },
            dcID,
            networkerPromise;

        var cachedNetworker;
        var stack = (new Error()).stack;
        if (!stack) {
            try {
                window.unexistingFunction();
            } catch (e) {
                stack = e.stack || '';
            }
        }
        var performRequest = function (networker) {
            return (cachedNetworker = networker).wrapApiCall(method, params, options).then(
                function (result) {
                    deferred.resolve(result);
                },
                function (error) {
                    console.error(dT(), 'Error', error.code, error.type, baseDcID, dcID);
                    if (error.code == 401 && baseDcID == dcID) {
                        _Storage.remove('dc', 'user_auth');
                        telegramMeNotify(false);
                        rejectPromise(error);
                    }
                    else if (error.code == 401 && baseDcID && dcID != baseDcID) {
                        if (cachedExportPromise[dcID] === undefined) {
                            var exportDeferred = $q.defer();

                            mtpInvokeApi('auth.exportAuthorization', {dc_id: dcID}, {noErrorBox: true}).then(function (exportedAuth) {
                                mtpInvokeApi('auth.importAuthorization', {
                                    id: exportedAuth.id,
                                    bytes: exportedAuth.bytes
                                }, {dcID: dcID, noErrorBox: true}).then(function () {
                                    exportDeferred.resolve();
                                }, function (e) {
                                    exportDeferred.reject(e);
                                })
                            }, function (e) {
                                exportDeferred.reject(e)
                            });

                            cachedExportPromise[dcID] = exportDeferred.promise;
                        }

                        cachedExportPromise[dcID].then(function () {
                            (cachedNetworker = networker).wrapApiCall(method, params, options).then(function (result) {
                                deferred.resolve(result);
                            }, rejectPromise);
                        }, rejectPromise);
                    }
                    else if (error.code == 303) {
                        var newDcID = error.type.match(/^(PHONE_MIGRATE_|NETWORK_MIGRATE_|USER_MIGRATE_)(\d+)/)[2];
                        if (newDcID != dcID) {
                            if (options.dcID) {
                                options.dcID = newDcID;
                            } else {
                                _Storage.set({dc: baseDcID = newDcID});
                            }

                            mtpGetNetworker(newDcID, options).then(function (networker) {
                                networker.wrapApiCall(method, params, options).then(function (result) {
                                    deferred.resolve(result);
                                }, rejectPromise);
                            }, rejectPromise);
                        }
                    }
                    else if (!options.rawError && error.code == 420) {
                        var waitTime = error.type.match(/^FLOOD_WAIT_(\d+)/)[1] || 10;
                        if (waitTime > (options.timeout || 60)) {
                            return rejectPromise(error);
                        }
                        setTimeout(function () {
                            performRequest(cachedNetworker);
                        }, waitTime * 1000);
                    }
                    else if (!options.rawError && (error.code == 500 || error.type == 'MSG_WAIT_FAILED')) {
                        var now = tsNow();
                        if (options.stopTime) {
                            if (now >= options.stopTime) {
                                return rejectPromise(error);
                            }
                        } else {
                            options.stopTime = now + (options.timeout !== undefined ? options.timeout : 10) * 1000;
                        }
                        options.waitTime = options.waitTime ? Math.min(60, options.waitTime * 1.5) : 1;
                        setTimeout(function () {
                            performRequest(cachedNetworker);
                        }, options.waitTime * 1000);
                    }
                    else {
                        rejectPromise(error);
                    }
                });
        };

        if (dcID = (options.dcID || baseDcID)) {
            mtpGetNetworker(dcID, options).then(performRequest, rejectPromise);
        } else {
            _Storage.get('dc').then(function (baseDcID) {
                mtpGetNetworker(dcID = baseDcID || 2, options).then(performRequest, rejectPromise);
            });
        }

        return deferred.promise;
    };

    function mtpGetUserID() {
        return _Storage.get('user_auth').then(function (auth) {
            telegramMeNotify(auth && auth.id > 0 || false);
            return auth.id || 0;
        });
    }

    function getBaseDcID() {
        return baseDcID || false;
    }

    return {
        getBaseDcID: getBaseDcID,
        getUserID: mtpGetUserID,
        invokeApi: mtpInvokeApi,
        getNetworker: mtpGetNetworker,
        setUserAuth: mtpSetUserAuth,
        logOut: mtpLogOut
    }
})();