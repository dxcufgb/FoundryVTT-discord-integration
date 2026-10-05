// Planned sessions. Owns no timers: index.js calls tick() right after every
// Foundry poll and hands it the monitor's events. Two jobs:
//
//   1. `reminderMinutes` (15) before a campaign's next session, check that the
//      campaign's world is the one running. If not, emit
//        { type: "sessionWorldNotUp", guildId, channelId, campaign, at, foundry }
//      which tags the DM. Sent once per planned session time; a failed Discord
//      delivery is retried on the next tick.
//   2. When the monitor reports a world start, emit for every campaign bound
//      to that world (in every server)
//        { type: "worldReady", guildId, channelId, campaign, status, session }
//      which tags the players.
//
// Sessions that are more than SESSION_LINGER_MS in the past are moved to
// `lastSession` so the campaign is ready for the next one.

import { DEFAULT_REMINDER_MINUTES, isCurrentSession } from "./campaigns.js";

export class SessionScheduler {
  /**
   * @param {object} deps
   * @param {import("./state.js").StateStore} deps.state
   * @param {(event: object) => Promise<void>|void} deps.emit
   * @param {{ reminderMinutes?: number }} [deps.options]
   * @param {() => Date} [deps.now]
   * @param {{debug:Function,info:Function,warn:Function,error:Function}} [deps.log]
   */
  constructor({ state, emit, options = {}, now = () => new Date(), log = console }) {
    this.state = state;
    this.emit = emit;
    this.options = { reminderMinutes: DEFAULT_REMINDER_MINUTES, ...options };
    this.now = now;
    this.log = log;
    this.ticking = false;
  }

  get reminderMs() {
    return this.options.reminderMinutes * 60_000;
  }

  async send(event) {
    try {
      await this.emit(event);
      return true;
    } catch (err) {
      this.log.error(`failed to deliver ${event.type} event:`, err);
      return false;
    }
  }

  /** Every (guildId, campaign) pair, in a stable order. */
  allCampaigns() {
    const out = [];
    for (const guildId of Object.keys(this.state.data.guilds)) for (const campaign of this.state.campaigns(guildId)) out.push({ guildId, campaign });
    return out;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const { guildId, campaign } of this.allCampaigns()) await this.checkCampaign(guildId, campaign);
    } catch (err) {
      this.log.error("session check failed:", err);
    } finally {
      this.ticking = false;
    }
  }

  async checkCampaign(guildId, campaign) {
    const session = campaign.nextSession;
    if (!session?.at) return;
    const now = this.now();
    const at = new Date(session.at);

    if (!isCurrentSession(session, now)) {
      this.state.updateCampaign(guildId, campaign.id, (c) => {
        c.lastSession = c.nextSession;
        c.nextSession = null;
        c.reminderSentFor = null;
      });
      this.log.debug(`session of ${campaign.name} (${guildId}) at ${session.at} is over; cleared`);
      return;
    }

    if (now.getTime() >= at.getTime()) return; // started: nothing more to check
    if (now.getTime() < at.getTime() - this.reminderMs) return; // not yet time
    if (campaign.reminderSentFor === session.at) return; // already handled for this time

    const foundry = this.state.data.foundry;
    const worldUp = foundry.status === "up" && foundry.world === campaign.world;
    if (worldUp) {
      this.state.updateCampaign(guildId, campaign.id, (c) => {
        c.reminderSentFor = session.at;
      });
      this.log.debug(`world ${campaign.world} is up ahead of the ${campaign.name} session; no reminder needed`);
      return;
    }
    const ok = await this.send({
      type: "sessionWorldNotUp",
      guildId,
      channelId: campaign.channel ?? null,
      campaign,
      at,
      foundry: { status: foundry.status, world: foundry.world },
    });
    if (ok) {
      this.state.updateCampaign(guildId, campaign.id, (c) => {
        c.reminderSentFor = session.at;
      });
    }
  }

  /** Feed the monitor's events in; only worldStarted matters here. */
  async onMonitorEvent(event) {
    if (event?.type !== "worldStarted" || !event.world) return 0;
    let sent = 0;
    const now = this.now();
    for (const { guildId, campaign } of this.state.campaignsForWorld(event.world)) {
      const session = isCurrentSession(campaign.nextSession, now) ? campaign.nextSession : null;
      if (await this.send({ type: "worldReady", guildId, channelId: campaign.channel ?? null, campaign, status: event.status ?? {}, session })) sent += 1;
    }
    return sent;
  }
}
