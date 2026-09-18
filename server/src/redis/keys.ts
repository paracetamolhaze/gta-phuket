/** Every Redis key the server uses, in one place. */
export const K = {
  /** Latest GPS sample (JSON GpsSample). */
  gpsLatest: (channelId: string) => `gta:${channelId}:gps:latest`,
  /** Recent samples for the privacy delay buffer (sorted set by receivedAt). */
  gpsBuffer: (channelId: string) => `gta:${channelId}:gps:buffer`,

  /** Cached ChannelSettings JSON. */
  settings: (channelId: string) => `gta:${channelId}:settings`,

  /** Serialised quote JSON, expires with the quote. */
  quote: (quoteId: string) => `gta:quote:${quoteId}`,
  /** Quote id currently held by a viewer, to stop them stacking quotes. */
  viewerQuote: (channelId: string, userId: string) => `gta:${channelId}:viewerquote:${userId}`,

  /** Cached ActiveWaypointView JSON, or absent when idle. */
  activeWaypoint: (channelId: string) => `gta:${channelId}:waypoint:active`,

  /** Mutex taken while activating a redemption. */
  lockActivation: (channelId: string) => `gta:${channelId}:lock:activation`,
  /** Mutex taken while leasing a reward slot. */
  lockSlots: (channelId: string) => `gta:${channelId}:lock:slots`,
  /** Mutex around the broadcaster token refresh. */
  lockTokenRefresh: (channelId: string) => `gta:${channelId}:lock:token`,
  /** Mutex around creating/reconciling the GTA$ exchange reward on Twitch. */
  lockExchangeReward: (channelId: string) => `gta:${channelId}:lock:exchangereward`,
  /** Mutex around the exchange-redemption fulfilment retry sweep. */
  lockFulfillment: (channelId: string) => `gta:${channelId}:lock:fulfillment`,

  /** EventSub message-id seen marker. */
  eventSeen: (messageId: string) => `gta:eventsub:seen:${messageId}`,
  /** Redemption id seen marker, guards duplicate deliveries of one redemption. */
  redemptionSeen: (redemptionId: string) => `gta:eventsub:redemption:${redemptionId}`,

  /** Sliding-window rate limit counter. */
  rate: (bucket: string, subject: string) => `gta:rate:${bucket}:${subject}`,

  /** Cached Mapbox walking route, keyed by rounded origin+destination. */
  routeCache: (hash: string) => `gta:route:${hash}`,
  /** Cached Mapbox search results. */
  searchCache: (hash: string) => `gta:search:${hash}`,

  /** Pub/sub channel that fans realtime events between API instances. */
  realtimeChannel: 'gta:realtime',

  /** Live-route recompute throttle. */
  liveRouteThrottle: (channelId: string) => `gta:${channelId}:liveroute:throttle`,
} as const;
