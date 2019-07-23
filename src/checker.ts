import Main from "./main";
import {everyMinutes} from "./tools/everyTime";
import serviceId from "./tools/serviceId";
import ensureMap from "./tools/ensureMap";

const debug = require('debug')('app:Checker');

export interface RawStream {
  id: string|number,
  url: string,
  title: string,
  game: string|null,
  isRecord: boolean,
  previews: string[],
  viewers: number|null,
  channelId: string|number,
  channelTitle: string,
}

interface Stream extends RawStream {
  id: string,
  channelId: string,
}

export interface ServiceInterface {
  id: string,
  name: string,
  batchSize: number,
  match(string): boolean,
  getStreams(channelsIds: (string|number)[]): Promise<{streams: RawStream[], skippedChannelIds: (string|number)[], removedChannelIds: (string|number)[]}>,
  getExistsChannelIds(channelsIds: (string|number)[]): Promise<(string|number)[]>,
  findChannel(query: string): Promise<{id: string|number, title: string, url: string}>,
}

interface Channel {
  id: string,
  service: string,
  title: string,
  url: string,
  lastSyncAt: Date,
  syncTimeoutExpiresAt: Date
}

interface DbChannel extends Channel {
  get: (any) => Channel
}

class Checker {
  main: Main;
  constructor(main) {
    this.main = main;
  }

  init() {
    this.startUpdateInterval();
  }

  updateTimer = null;
  startUpdateInterval() {
    this.updateTimer && this.updateTimer();
    this.updateTimer = everyMinutes(this.main.config.emitCheckChannelsEveryMinutes, () => {
      this.check().catch((err) => {
        debug('check error', err);
      });
    });
  }

  check = async () => {
    this.main.services.forEach((service) => {
      if (!this.serviceThread.has(service)) {
        this.serviceThread.set(service, this.runThread(service));
      }
    });
  };

  serviceThread = new Map();

  async runThread(service: ServiceInterface) {
    while (true) {
      const channels: DbChannel[] = await this.main.db.getServiceChannelsForSync(service.id, service.batchSize);
      if (!channels.length) {
        break;
      }

      const channelIdChannel: Map<string, DbChannel> = new Map();
      const channelIds: string[] = [];
      const rawChannelIds: (string|number)[] = [];
      channels.forEach((channel) => {
        channelIdChannel.set(channel.id,  channel);
        channelIds.push(channel.id);
        rawChannelIds.push(serviceId.unwrap(channel.id));
      });

      const syncAt = new Date();
      await this.main.db.setChannelsSyncTimeoutExpiresAt(channelIds).then(() => {
        return service.getStreams(rawChannelIds);
      }).then(({streams: rawStreams, skippedChannelIds: skippedRawChannelIds, removedChannelIds: removedRawChannelIds}) => {
        const streamIdStream:Map<string, Stream> = new Map();
        const streams: Stream[] = [];

        const skippedChannelIds = skippedRawChannelIds.map(id => serviceId.wrap(service, id));
        const removedChannelIds = removedRawChannelIds.map(id => serviceId.wrap(service, id));

        rawStreams.forEach((rawStream) => {
          const stream: Stream = Object.assign({}, rawStream, {
            id: serviceId.wrap(service, rawStream.id),
            channelId: serviceId.wrap(service, rawStream.channelId),
          });

          if (!channelIdChannel.has(stream.channelId)) {
            debug('Stream %s skip, cause: Channel %s is not exists', stream.id, stream.channelId);
            return;
          }

          streamIdStream.set(stream.id, stream);
          streams.push(stream);
        });

        const checkedChannelIds = channelIds.slice(0);
        skippedChannelIds.forEach((id) => {
          const pos = checkedChannelIds.indexOf(id);
          if (pos !== -1) {
            checkedChannelIds.splice(pos, 1);
          }
        });
        removedChannelIds.forEach((id) => {
          const pos = checkedChannelIds.indexOf(id);
          if (pos !== -1) {
            checkedChannelIds.splice(pos, 1);
          }
        });

        return {streams, streamIdStream, checkedChannelIds, skippedChannelIds, removedChannelIds};
      }).then(({streams, streamIdStream, checkedChannelIds, skippedChannelIds, removedChannelIds}) => {
        const channelIdsChanges:{[s: string]: {[s: string]: any}} = {};
        const channelIdSteamIds:Map<string, string[]> = new Map();

        checkedChannelIds.forEach((id) => {
          const channel = channelIdChannel.get(id);
          channelIdsChanges[id] = Object.assign({}, channel.get({plain: true}), {
            lastSyncAt: syncAt
          });
        });

        streams.forEach((stream) => {
          const channel = channelIdChannel.get(stream.channelId);
          const channelChanges = channelIdsChanges[channel.id];

          const title = channelChanges.title || channel.title;
          if (title !== stream.channelTitle) {
            channelChanges.title = stream.channelTitle;
          }

          const channelStreamIds = ensureMap(channelIdSteamIds, stream.channelId, []);
          channelStreamIds.push(stream.id);
        });

        //
      });
    }

    this.serviceThread.delete(service);
  }
}

export default Checker;