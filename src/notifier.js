// Delivers monitor events to Discord: one message per server that has a channel
// for the event's message type. Works with anything that looks like a
// discord.js Client (channels.fetch(id).send(payload)), so tests use a fake.

import { buildMessage, EVENT_MESSAGE_TYPE } from "./messages.js";

export class Notifier {
  /**
   * @param {object} deps
   * @param {{ channels: { fetch(id:string): Promise<any> } }} deps.client
   * @param {import("./state.js").StateStore} deps.state
   * @param {(id:string) => string|null} [deps.worldTitle]
   * @param {() => Date} [deps.now]
   * @param {object} [deps.log]
   */
  constructor({ client, state, worldTitle = () => null, now = () => new Date(), log = console }) {
    this.client = client;
    this.state = state;
    this.worldTitle = worldTitle;
    this.now = now;
    this.log = log;
  }

  /** Every (guildId, channelId) pair a message type should go to. */
  targets(messageType) {
    const out = [];
    for (const guildId of Object.keys(this.state.data.guilds)) {
      const channelId = this.state.resolveChannel(guildId, messageType);
      if (channelId) out.push({ guildId, channelId, mentionRole: this.state.guild(guildId).mentionRole ?? null });
    }
    return out;
  }

  /**
   * Send an event. Resolves to the number of channels it reached. Throws only if
   * at least one target existed and *none* could be reached, so the monitor can
   * retry once-only announcements later.
   */
  async deliver(event) {
    const messageType = EVENT_MESSAGE_TYPE[event.type];
    const targets = this.targets(messageType);
    if (!targets.length) {
      this.log.debug(`no channel configured for "${messageType}" messages; dropping ${event.type} event`);
      return 0;
    }
    let delivered = 0;
    const failures = [];
    for (const target of targets) {
      const payload = buildMessage(event, { now: this.now, worldTitle: this.worldTitle, mentionRole: target.mentionRole });
      try {
        await this.sendTo(target.channelId, payload);
        delivered += 1;
      } catch (err) {
        failures.push(`${target.guildId}/${target.channelId}: ${err?.message ?? err}`);
      }
    }
    if (failures.length) this.log.warn(`could not post ${event.type} to ${failures.length} channel(s): ${failures.join("; ")}`);
    if (!delivered) throw new Error(`could not deliver ${event.type} to any channel`);
    return delivered;
  }

  async sendTo(channelId, payload) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== "function") throw new Error(`channel ${channelId} not found or not a text channel`);
    const { messageType, ...body } = payload;
    return channel.send(body);
  }
}
