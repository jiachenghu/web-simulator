/*
 *  Copyright 2012 Intel Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var db = require('ripple/db'),
    event = require('ripple/event'),
    errorcode = require('ripple/platform/tizen/2.0/errorcode'),
    filesystem = require('ripple/platform/tizen/2.0/filesystem'),
    WebAPIError = require('ripple/platform/tizen/2.0/WebAPIError'),
    DownloadRequest = require('ripple/platform/tizen/2.0/DownloadRequest'),
    DownloadState = {
        QUEUED: "QUEUED",
        DOWNLOADING: "DOWNLOADING",
        PAUSED: "PAUSED",
        CANCELED: "CANCELED",
        COMPLETED: "COMPLETED",
        FAILED: "FAILED"
    },
    DB_DOWNLOAD_KEY = "tizen1-db-download",
    DownloadItem, _isInitialized = false, INTERVAL = 1000,
    _downloads = [], _resources = [], _self;

function _checkDownloadParamters(download, callback) {
    if (download === undefined || download === null || download.url === null || download.url === undefined) {
        throw (new WebAPIError(errorcode.TYPE_MISMATCH_ERR));
    }
    if (callback !== undefined && callback !== null &&
        (typeof callback.onprogress !== 'function' ||
         typeof callback.onpaused !== 'function' ||
         typeof callback.oncanceled !== 'function' ||
         typeof callback.oncompleted !== 'function' ||
         typeof callback.onfailed !== 'function')) {
        throw (new WebAPIError(errorcode.TYPE_MISMATCH_ERR));
    }
}

function _initDownloadItem(download) {
    var url, index, isExist = false;
    url = download.url;
    if (download.destination === null) {
        download.destination = "downloads";
    }
    if (download.fileName === null) {
        index = url.lastIndexOf('\/') + 1;
        download.fileName = url.substring(index);
    }
    if (!_isInitialized) {
        initializeResource();
    }
    _resources.some(function (value) {
        if (value.url === url) {
            download.size           = value.size;
            download.speed          = Number(value.speed);
            download.estimatedTime = Math.round(value.estimatedTime * 100) / 100;
            download.MIMEType       = value.MIMEType;
            isExist =  true;
            return;
        }
    });
    if (!isExist) {
        _exec(download.callback, 'onfailed', download.id, new WebAPIError(errorcode.NOT_FOUND_ERR));
        return;
    }
    return download;
}

function _exec(callback, name, downloadId, arg1, arg2) {
    if (callback === null) {
        return;
    }
    switch (name) {
    case "onprogress" :
        callback[name](downloadId, arg1, arg2);
        break;
    case "onpaused" :
        callback[name](downloadId);
        break;
    case "oncanceled" :
        callback[name](downloadId);
        break;
    case "oncompleted" :
        callback[name](downloadId, arg1);
        break;
    case "onfailed" :
        callback[name](downloadId, arg1);
        break;
    default:
        break;
    }
}

function _getDownloadObjById(id) {
    var isFound = false, backObj;
    if (id === null || id === undefined) {
        throw new WebAPIError(errorcode.TYPE_MISMATCH_ERR);
    }
    id = Number(id);
    _downloads.some(function (obj) {
        if (obj.id === id) {
            backObj = obj;
            isFound = true;
            return;
        }
    });
    if (!isFound) {
        throw new WebAPIError(errorcode.NOT_FOUND_ERR);
    }
    return backObj;
}

function initializeResource() {
    _resources = db.retrieveObject(DB_DOWNLOAD_KEY);
    _isInitialized = true;
}

function _saveFile(downloadObj, callback) {
    var name, path, content;

    name = downloadObj.fileName;
    path = downloadObj.destination;
    content = 'size|' + downloadObj.size + ',speed|' + downloadObj.speed + ',url|' + downloadObj.url + ',estimatedTime|' + downloadObj.estimatedTime;
    function onsuccess(fs) {
        fs.write(content);
        fs.close();
    }
    function onerror(e) {
        _exec(downloadObj.callback, 'onfailed', downloadObj.id, e);
    }
    function rename(name) { //index.html==>index_1.html
        var index, c;
        index = name.lastIndexOf('.');
        if (index < 0) {
            index = name.length;
        }
        c = name.substr(index - 2, 1);
        if (c === '_') {
            name = name.substr(0, index - 1) + (Number(name.substr(index - 1, 1)) + 1) + name.substring(index);
        } else {
            name = name.substr(0, index) + "_1" + name.substring(index);
        }
        return name;
    }

    filesystem.resolve(path, function (dir) {
        var file, isExist = true;
        while (isExist) {
            try {
                file = dir.resolve(name);
                name = rename(name);
            } catch (e) {
                isExist = false;
            }
        }
        file = dir.createFile(name);
        file.openStream('w', onsuccess, onerror, 'UTF-8');
        callback(name);
    }, onerror, "rw");
}

DownloadItem = function (download, callback) {
    var _self;
    _self = {
        id           : Number(Math.uuid(8, 10)),
        url          : download.url,
        state        : DownloadState.QUEUED,
        fileName     : download.fileName || null,
        destination  : download.destination || null,
        callback     : callback || null
    };
    return _self;
};

_self = {
    start: function (downloadRequest, downloadCallback) {
        var downloadObj, fileSize, increment, receivedSize = 0, intervalId;

        _checkDownloadParamters(downloadRequest, downloadCallback);
        downloadObj = new DownloadItem(downloadRequest, downloadCallback);
        downloadObj = _initDownloadItem(downloadObj);
        downloadObj.state = DownloadState.DOWNLOADING;
        _downloads.push(downloadObj);

        fileSize = downloadObj.size;
        increment = downloadObj.speed;
        intervalId = setInterval(function () {
            if (receivedSize >= fileSize) {//Finish downloading
                receivedSize = fileSize;
                _saveFile(downloadObj, function (fileName) {
                    _exec(downloadObj.callback, 'oncompleted', downloadObj.id, fileName);
                });
                clearInterval(intervalId);
            } else { // Continue downloading
                receivedSize += increment;
                downloadObj.receivedSize = receivedSize;
                _exec(downloadObj.callback, 'onprogress', downloadObj.id, receivedSize, fileSize);
            }
        }, INTERVAL);
        downloadObj.intervalId = intervalId;
        return downloadObj.id;
    },

    cancel: function (downloadId) {
        var downloadObj = _getDownloadObjById(downloadId);
        clearInterval(downloadObj.intervalId);
        downloadObj.state = DownloadState.CANCELED;
        _exec(downloadObj.callback, 'oncanceled', downloadObj.id);
    },

    pause: function (downloadId) {
        var downloadObj = _getDownloadObjById(downloadId);
        clearInterval(downloadObj.intervalId);
        downloadObj.state = DownloadState.PAUSED;
        _exec(downloadObj.callback, 'onpaused', downloadObj.id);
    },

    resume: function (downloadId) {
        var downloadObj, fileSize, receivedSize, increment, intervalId;

        downloadObj  = _getDownloadObjById(downloadId);
        fileSize     = downloadObj.size;
        receivedSize = downloadObj.receivedSize;
        increment    = downloadObj.speed;

        if (downloadObj.state !== DownloadState.PAUSED) {
            _exec(downloadObj.callback, 'onfailed', downloadObj.id, new WebAPIError(errorcode.INVALID_VALUES_ERR));
            return;
        }
        downloadObj.state = DownloadState.DOWNLOADING;
        intervalId = setInterval(function () {
            if (receivedSize >= fileSize) {//Finish downloading
                receivedSize = fileSize;
                _saveFile(downloadObj, function (fileName) {
                    _exec(downloadObj.callback, 'oncompleted', downloadObj.id, fileName);
                });
                clearInterval(intervalId);
            } else {// Continue downloading
                receivedSize += increment;
                downloadObj.receivedSize = receivedSize;
                _exec(downloadObj.callback, 'onprogress', downloadObj.id, receivedSize, fileSize);
            }
        }, INTERVAL);
        downloadObj.intervalId = intervalId;
    },

    getState: function (downloadId) {
        var downloadObj = _getDownloadObjById(downloadId);
        return downloadObj.state;
    },

    getDownloadRequest: function (downloadId) {
        var req, downloadObj;
        downloadObj = _getDownloadObjById(downloadId);
        req = new DownloadRequest(downloadObj.url, downloadObj.destination, downloadObj.fileName);
        return req;
    },

    getMIMEType: function (downloadId) {
        var downloadObj = _getDownloadObjById(downloadId);
        return downloadObj.MIMEType;
    },

    setListener: function (downloadId, callback) {
        var downloadObj = _getDownloadObjById(downloadId);
        if (callback !== undefined && callback !== null &&
            (typeof callback.onprogress !== 'function' ||
            typeof callback.onpaused !== 'function' ||
            typeof callback.oncanceled !== 'function' ||
            typeof callback.oncompleted !== 'function' ||
            typeof callback.onfailed !== 'function')) {
            throw (new WebAPIError(errorcode.TYPE_MISMATCH_ERR));
        }
        downloadObj.callback = callback;
    }
};

event.on('downloadResourceChanged', function () {
    _isInitialized = false;
});
module.exports = _self;

