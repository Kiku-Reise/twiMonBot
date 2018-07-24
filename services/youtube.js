/**
 * Created by Anton on 06.12.2015.
 */
"use strict";
const debug = require('debug')('app:youtube');
const base = require('../base');
const CustomError = require('../customError').CustomError;
const got = require('got');

const apiQuote = new base.Quote(1000);
const gotLimited = apiQuote.wrapper(got);

var Youtube = function(options) {
    this.gOptions = options;
    this.channels = options.channels;
    this.name = 'youtube';
    this.config = {
        token: options.config.ytToken
    };
};

Youtube.prototype.isServiceUrl = function (url) {
    return [
        /youtu\.be\//i,
        /youtube\.com\//i
    ].some(function (re) {
        return re.test(url);
    });
};

Youtube.prototype.getChannelUrl = function (channelName) {
    return 'https://youtube.com/channel/' + channelName;
};

Youtube.prototype.insertItem = function (channel, snippet, id, viewers) {
    var _this = this;
    return Promise.resolve().then(function () {
        if (snippet.liveBroadcastContent !== 'live') {
            return;
        }

        var previewList = ['maxresdefault_live', 'sddefault_live', 'hqdefault_live', 'mqdefault_live', 'default_live'].map(function(quality) {
            return 'https://i.ytimg.com/vi/' + id + '/' + quality + '.jpg';
        });

        /*var previewList = Object.keys(snippet.thumbnails).map(function(quality) {
            return snippet.thumbnails[quality];
        }).sort(function(a, b) {
            return a.width > b.width ? -1 : 1;
        }).map(function(item) {
            return item.url;
        });*/

        var game = '';

        var data = {
            isRecord: false,
            viewers: viewers,
            game: game,
            preview: previewList,
            created_at: snippet.publishedAt,
            channel: {
                name: snippet.channelTitle || snippet.channelId,
                status: snippet.title,
                url: 'https://gaming.youtube.com/watch?v=' + id
            }
        };

        var item = {
            id: _this.channels.wrapId(id, _this.name),
            channelId: channel.id,
            data: JSON.stringify(data),
            checkTime: base.getNow(),
            isOffline: 0,
            isTimeout: 0
        };

        var promise = Promise.resolve();
        if (channel.title !== data.channel.name) {
            promise = promise.then(function () {
                channel.title = data.channel.name;
                return _this.channels.updateChannel(channel.id, channel);
            });
        }

        return promise.then(function () {
            return item;
        });
    });
};

var insertPool = new base.Pool(15);

var intRe = /^\d+$/;

Youtube.prototype.getViewers = function(id) {
    return gotLimited('https://gaming.youtube.com/live_stats', {
        query: {
            v: id,
            t: Date.now()
        }
    }).then(({body}) => {
        if (!intRe.test(body)) {
            throw new Error('NOT INT ' + JSON.stringify(body));
        }

        return parseInt(body, 10);
    }).catch(function (err) {
        debug('getViewers %s error! %o', id, err);
        return -1;
    });
};

Youtube.prototype.isLiveFilter = function(items, channelId) {
    const idItemMap = {};
    items.forEach(item => {
        idItemMap[item.id.videoId] = item;
    });
    const videoIds = Object.keys(idItemMap);

    return gotLimited('https://www.googleapis.com/youtube/v3/videos', {
        query: {
            part: 'snippet',
            id: videoIds.join(','),
            maxResults: videoIds.length,
            fields: 'items(id,snippet/liveBroadcastContent)',
            key: this.config.token
        },
        json: true
    }).then(({body}) => {
        const result = [];
        body.items.forEach(item => {
            if (item.snippet.liveBroadcastContent === 'live') {
                result.push(idItemMap[item.id]);
            }
        });
        if (videoIds.length !== result.length) {
            debug('Still exists api bug', channelId);
        }
        return result;
    }).catch(function (err) {
        debug('isLive %s error! %o', channelId, err);
        return items;
    });
};

var requestPool = new base.Pool(10);

Youtube.prototype.getStreamList = function(_channelList) {
    var _this = this;

    var getPage = function (/*dbChannel*/channel) {
        var retryLimit = 1;
        var requestPage = function () {
            return gotLimited('https://www.googleapis.com/youtube/v3/search', {
                query: {
                    part: 'snippet',
                    channelId: _this.channels.unWrapId(channel.id),
                    eventType: 'live',
                    maxResults: 5,
                    order: 'date',
                    safeSearch: 'none',
                    type: 'video',
                    fields: 'items(id/videoId,snippet)',
                    key: _this.config.token
                },
                json: true
            }).then(({body}) => {
                if (!Array.isArray(body && body.items)) {
                    var err = new Error('Unexpected response');
                    err.channelId = _this.channels.unWrapId(channel.id);
                    err.responseBody = body;
                    throw err;
                }

                return body;
            }).catch(err => {
                if (retryLimit-- < 1) {
                    throw err;
                }

                return new Promise(function (resolve) {
                    setTimeout(resolve, 250);
                }).then(function () {
                    // debug('Retry %s requestPage %s', retryLimit, channelId, err);
                    return requestPage();
                });
            });
        };

        return requestPage().then(({items}) => {
            // todo: disable me after bug fix
            if (items.length) {
                return _this.isLiveFilter(items, _this.channels.unWrapId(channel.id));
            } else {
                return items;
            }
        }).then(function (items) {
            return insertPool.do(function () {
                var item = items.shift();
                if (!item) return;

                var snippet = item.snippet;
                var videoId = item.id.videoId;

                return _this.getViewers(videoId).then(function(viewers) {
                    return _this.insertItem(channel, snippet, videoId, viewers).then(function (item) {
                        item && streamList.push(item);
                    }).catch(function (err) {
                        streamList.push(base.getTimeoutStream(channel));
                        debug("insertItem error!", err);
                    });
                });
            });
        }).catch(function(err) {
            streamList.push(base.getTimeoutStream(channel));
            debug('Stream %s response error! %o', channel.id, err);
        });
    };

    var promise = Promise.resolve(_channelList);

    promise = promise.then(function (channels) {
        return requestPool.do(function () {
            var channel = channels.shift();
            if (!channel) return;

            return getPage(channel);
        });
    });

    var streamList = [];
    return promise.then(function() {
        return streamList;
    });
};

/**
 * @param {dbChannel} channel
 * @return {Promise.<dbChannel>}
 */
Youtube.prototype.channelExists = function (channel) {
    var _this = this;
    const channelId = _this.channels.unWrapId(channel.id);
    return _this.getChannelId(channelId);
};

Youtube.prototype.hasBroadcasts = function (channelId) {
    const _this = this;
    const hasBroadcast = function (type) {
        return gotLimited('https://www.googleapis.com/youtube/v3/search', {
            query: {
                part: 'snippet',
                channelId: channelId,
                eventType: type,
                maxResults: 1,
                order: 'date',
                safeSearch: 'none',
                type: 'video',
                fields: 'items(id/videoId)',
                key: _this.config.token
            },
            json: true
        }).then(({body}) => {
            return body.items;
        });
    };
    return hasBroadcast('completed').then(function (list) {
        if (list.length) return list;

        return hasBroadcast('live').then(function (list) {
            if (list.length) return list;

            return hasBroadcast('upcoming');
        });
    }).then(function (list) {
        return !!list.length;
    });
};

/**
 * @param {String} rawQuery
 * @return {Promise.<string>}
 */
Youtube.prototype.requestChannelIdByQuery = function(rawQuery) {
    var _this = this;

    var query = '';
    [
        /youtube\.com\/(?:#\/)?c\/([\w\-]+)/i
    ].some(function (re) {
        var m = re.exec(rawQuery);
        if (m) {
            query = m[1];
            return true;
        }
    });

    if (!query) {
        query = rawQuery;
    }

    return gotLimited('https://www.googleapis.com/youtube/v3/search', {
        query: {
            part: 'snippet',
            q: query,
            type: 'channel',
            maxResults: 1,
            fields: 'items(id)',
            key: _this.config.token
        },
        json: true
    }).then(({body}) => {
        var channelId = '';
        body.items.some(function (item) {
            return channelId = item.id.channelId;
        });
        if (!channelId) {
            throw new CustomError('Channel ID is not found by query!');
        }

        return channelId;
    });
};

/**
 * @param {String} url
 * @return {Promise.<String>}
 */
Youtube.prototype.requestChannelIdByUsername = function(url) {
    var _this = this;

    var username = '';
    [
        /youtube\.com\/(?:#\/)?user\/([\w\-]+)/i,
        /youtube\.com\/([\w\-]+)/i
    ].some(function (re) {
        var m = re.exec(url);
        if (m) {
            username = m[1];
            return true;
        }
    });

    if (!username) {
        username = url;
    }

    if (!/^[\w\-]+$/.test(username)) {
        return Promise.reject(new CustomError('It is not username!'));
    }

    return gotLimited('https://www.googleapis.com/youtube/v3/channels', {
        query: {
            part: 'snippet',
            forUsername: username,
            maxResults: 1,
            fields: 'items/id',
            key: _this.config.token
        },
        json: true
    }).then(({body}) => {
        var id = '';
        body.items.some(function (item) {
            return id = item.id;
        });
        if (!id) {
            throw new CustomError('Channel ID is not found by username!');
        }

        return id;
    });
};

/**
 * @param {String} url
 * @returns {Promise.<String>}
 */
Youtube.prototype.getChannelIdByUrl = function (url) {
    var channelId = '';
    [
        /youtube\.com\/(?:#\/)?channel\/([\w\-]+)/i
    ].some(function (re) {
        var m = re.exec(url);
        if (m) {
            channelId = m[1];
            return true;
        }
    });

    if (!channelId) {
        channelId = url;
    }

    if (!/^UC/.test(channelId)) {
        return Promise.reject(new CustomError('It is not channel url!'));
    }

    return Promise.resolve(channelId);
};

/**
 * @param {String} url
 * @return {Promise.<string>}
 */
Youtube.prototype.requestChannelIdByVideoUrl = function (url) {
    var _this = this;

    var videoId = '';
    [
        /youtu\.be\/([\w\-]+)/i,
        /youtube\.com\/.+[?&]v=([\w\-]+)/i,
        /youtube\.com\/(?:.+\/)?(?:v|embed)\/([\w\-]+)/i
    ].some(function (re) {
        var m = re.exec(url);
        if (m) {
            videoId = m[1];
            return true;
        }
    });

    if (!videoId) {
        return Promise.reject(new CustomError('It is not video url!'));
    }

    return gotLimited('https://www.googleapis.com/youtube/v3/videos', {
        query: {
            part: 'snippet',
            id: videoId,
            maxResults: 1,
            fields: 'items/snippet',
            key: _this.config.token
        },
        json: true
    }).then(({body}) => {
        var channelId = '';
        body.items.some(function (item) {
            return channelId = item.snippet.channelId;
        });
        if (!channelId) {
            throw new CustomError('Channel ID is empty');
        }

        return channelId;
    });
};

Youtube.prototype.getChannelId = function(channelName) {
    var _this = this;

    return _this.getChannelIdByUrl(channelName).catch(function (err) {
        if (!(err instanceof CustomError)) {
            throw err;
        }

        return _this.requestChannelIdByVideoUrl(channelName).catch(function (err) {
            if (!(err instanceof CustomError)) {
                throw err;
            }

            return _this.requestChannelIdByUsername(channelName).catch(function (err) {
                if (!(err instanceof CustomError)) {
                    throw err;
                }

                return _this.requestChannelIdByQuery(channelName);
            });
        });
    }).then(function(channelId) {
        return gotLimited('https://www.googleapis.com/youtube/v3/search', {
            query: {
                part: 'snippet',
                channelId: channelId,
                maxResults: 1,
                fields: 'items/snippet',
                key: _this.config.token
            },
            json: true
        }).then(({body}) => {
            var snippet = null;
            body.items.some(function (item) {
                return snippet = item.snippet;
            });
            if (!snippet) {
                throw new CustomError('Channel is not found');
            }

            var id = channelId;
            var title = snippet.channelTitle || channelId;
            var url = _this.getChannelUrl(channelId);

            return _this.hasBroadcasts(channelId).then(function (hasBroadcasts) {
                if (!hasBroadcasts) {
                    throw new CustomError('Channel broadcasts is not found');
                }

                return _this.channels.insertChannel(id, _this.name, title, url);
            });
        });
    });
};

module.exports = Youtube;