// AUTO-MIRRORED from server/src/domain/types.ts — do not edit by hand.
// Run `node scripts/sync-types.mjs` after changing the server contract.
/**
 * Shared domain contract.
 *
 * Everything that crosses a module boundary (HTTP, WebSocket, DB row shape)
 * is declared here so server modules and the web clients agree on one shape.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

/** GeoJSON-style [lng, lat]. Mapbox uses this order everywhere. */
export type LngLat = [number, number];

/** Outer ring of [lng, lat] pairs; the first point need not repeat at the end. */
export type PolygonRing = LngLat[];

export interface RestrictedZone {
  id: string;
  name: string;
  polygon: PolygonRing;
}

export interface BoundingBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------

export interface GpsSample {
  lat: number;
  lng: number;
  /** Metres of horizontal accuracy as reported by the device. */
  accuracy: number;
  /** Degrees clockwise from true north, or null when unknown. */
  heading: number | null;
  /** Metres per second, or null when unknown. */
  speed: number | null;
  /** Device clock, epoch ms. */
  timestamp: number;
  /** Server receive time, epoch ms. Authoritative for staleness. */
  receivedAt: number;
}

export type GpsStatus = 'ok' | 'stale' | 'missing' | 'inaccurate';

export interface GpsState {
  status: GpsStatus;
  /** Exact position. Only ever sent to streamer/admin/OBS clients. */
  sample: GpsSample | null;
  /** Age of the newest sample in ms, or null when there is none. */
  ageMs: number | null;
}

/** What a public viewer is allowed to see: delayed and/or rounded. */
export interface PublicGps {
  status: GpsStatus;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  speed: number | null;
  ageMs: number | null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface WalkingRoute {
  distanceMeters: number;
  durationSeconds: number;
  /** Encoded polyline, precision 6 (Mapbox `polyline6`). */
  geometry: string;
  /** Destination snapped onto the pedestrian network by the router. */
  snappedDestination: LatLng;
  /** Metres between the requested destination and the snapped one. */
  snapDistanceMeters: number;
}

export type RouteFailureReason =
  | 'no_walking_route'
  | 'too_far_from_walkable'
  | 'out_of_bounds'
  | 'restricted_zone'
  | 'too_far'
  | 'provider_error';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface PricingConfig {
  baseCost: number;
  pointsPer100Meters: number;
  minimumCost: number;
  maximumCost: number;
  roundTo: number;
}

export interface PriceBreakdown {
  baseCost: number;
  distanceMeters: number;
  /** ceil(distanceMeters / 100) */
  hundredMeterUnits: number;
  distanceCost: number;
  rawCost: number;
  /** Final, after rounding and clamping. This is what Twitch charges. */
  cost: number;
  clampedBy: 'minimum' | 'maximum' | null;
}

// ---------------------------------------------------------------------------
// Channel settings
// ---------------------------------------------------------------------------

export interface ChannelSettings {
  // pricing
  baseCost: number;
  pointsPer100Meters: number;
  minimumCost: number;
  maximumCost: number;
  roundTo: number;

  // limits
  maxWalkingDistanceMeters: number;
  quoteTtlSeconds: number;
  rewardSlotPoolSize: number;
  gpsTimeoutSeconds: number;
  maxGpsAccuracyMeters: number;
  /** Reject destinations the router had to snap further than this. */
  maxSnapDistanceMeters: number;

  // availability
  waypointsOpen: boolean;

  // privacy
  viewerLocationDelaySeconds: number;
  /** Decimal places kept in viewer-facing coordinates. 4 ~= 11 m. */
  viewerLocationPrecision: number;
  restrictedZones: RestrictedZone[];

  // rate limits (per viewer)
  quotesPerMinute: number;
  searchesPerMinute: number;

  // GTA DOLLAR economy
  /** GTA$ credited per ETH (Channel Point) spent on the exchange reward. */
  gtaDollarsPerChannelPoint: number;
  /** ETH cost of the «Обмен ETH на GTA DOLLAR» reward on Twitch. */
  exchangeRewardCost: number;
}

export const DEFAULT_SETTINGS: ChannelSettings = {
  baseCost: 100,
  pointsPer100Meters: 100,
  minimumCost: 100,
  maximumCost: 100000,
  roundTo: 50,

  maxWalkingDistanceMeters: 5000,
  quoteTtlSeconds: 60,
  rewardSlotPoolSize: 10,
  gpsTimeoutSeconds: 15,
  maxGpsAccuracyMeters: 100,
  maxSnapDistanceMeters: 150,

  waypointsOpen: true,

  viewerLocationDelaySeconds: 0,
  viewerLocationPrecision: 5,
  restrictedZones: [],

  quotesPerMinute: 10,
  searchesPerMinute: 30,

  gtaDollarsPerChannelPoint: 10,
  exchangeRewardCost: 500,
};

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * `gta_dollar`: waypoints are bought inside the map with the internal
 * currency. `channel_points_reward`: the legacy per-quote slot rewards, kept
 * for rollback.
 */
export type PaymentMode = 'gta_dollar' | 'channel_points_reward';

/** What a quote or a waypoint was (or will be) paid with. */
export type WaypointCurrency = 'GTA_DOLLAR' | 'CHANNEL_POINTS';

export type WalletTransactionType =
  | 'EXCHANGE_CREDIT'
  | 'WAYPOINT_DEBIT'
  | 'MISSION_REFUND'
  | 'ADMIN_ADJUSTMENT';

export type FulfillmentStatus = 'PENDING' | 'FULFILLED' | 'FAILED' | 'CANCELED_EXTERNALLY';

export interface WalletTransaction {
  id: string;
  channelId: string;
  twitchUserId: string;
  type: WalletTransactionType;
  /** Signed: credits are positive, debits negative. */
  amount: number;
  balanceAfter: number;
  twitchRedemptionId: string | null;
  twitchRewardId: string | null;
  channelPointsCost: number | null;
  quoteId: string | null;
  waypointId: string | null;
  fulfillmentStatus: FulfillmentStatus | null;
  fulfillmentAttempts: number;
  createdAt: number;
}

/** Exchange terms as the viewer sees them. Never hardcoded on the client. */
export interface EconomyInfo {
  symbol: 'GTA$';
  exchangeRate: number;
  rewardTitle: string;
  rewardCost: number;
  gtaPerRedemption: number;
  /** False while no exchange reward exists on Twitch. */
  available: boolean;
}

export interface WalletView {
  currency: 'GTA_DOLLAR';
  symbol: 'GTA$';
  balance: number;
  exchangeRate: number;
  exchange: Omit<EconomyInfo, 'symbol' | 'exchangeRate'>;
  recent: {
    id: string;
    type: WalletTransactionType;
    amount: number;
    balanceAfter: number;
    createdAt: string;
  }[];
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export type QuoteStatus =
  | 'QUOTED'
  | 'AWAITING_REDEMPTION'
  | 'PAID'
  | 'EXPIRED'
  | 'CANCELED';

export interface Quote {
  id: string;
  /** Short human-readable code shown in the reward title, e.g. "A7K3". */
  code: string;
  channelId: string;
  twitchUserId: string;
  twitchUserName: string | null;
  origin: LatLng;
  destination: LatLng;
  destinationName: string;
  destinationCategory: string | null;
  routeDistanceMeters: number;
  routeDurationSeconds: number;
  routeGeometry: string;
  /** The frozen price, in the quote's `currency` (the column predates GTA$). */
  channelPointsCost: number;
  currency: WaypointCurrency;
  status: QuoteStatus;
  /** Reward slot reserved at confirm time; null while status is QUOTED. */
  slotId: string | null;
  createdAt: number;
  expiresAt: number;
}

/** Quote as returned to the viewer. */
export interface QuoteView {
  quoteId: string;
  code: string;
  destinationName: string;
  destinationCategory: string | null;
  destination: LatLng;
  distanceMeters: number;
  durationSeconds: number;
  cost: number;
  expiresAt: number;
  status: QuoteStatus;
  routeGeometry: string;
  /** Reward title the viewer must look for in the Channel Points menu. */
  rewardTitle: string | null;
  currency: WaypointCurrency;
}

// ---------------------------------------------------------------------------
// Waypoints
// ---------------------------------------------------------------------------

export type WaypointStatus =
  | 'IDLE'
  | 'QUOTING'
  | 'AWAITING_REDEMPTION'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELED';

export interface Waypoint {
  id: string;
  channelId: string;
  quoteId: string;
  twitchUserId: string;
  twitchUserName: string | null;
  destination: LatLng;
  destinationName: string;
  destinationCategory: string | null;
  routeDistanceMeters: number;
  routeDurationSeconds: number;
  routeGeometry: string;
  /** What was paid, in `currency`. */
  channelPointsPaid: number;
  currency: WaypointCurrency;
  status: WaypointStatus;
  activatedAt: number;
  completedAt: number | null;
  canceledAt: number | null;
  cancelReason: string | null;
}

/** Live navigation state, recomputed as GPS moves. */
export interface ActiveWaypointView {
  id: string;
  destinationName: string;
  destinationCategory: string | null;
  destination: LatLng;
  /** Original purchased route (for display). */
  routeGeometry: string;
  /** Length of the route as it was bought. Progress bars measure against this. */
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  /** Live re-routed geometry from the streamer's current position. */
  liveRouteGeometry: string | null;
  remainingDistanceMeters: number | null;
  remainingDurationSeconds: number | null;
  paidBy: string | null;
  channelPointsPaid: number;
  currency: WaypointCurrency;
  activatedAt: number;
}

// ---------------------------------------------------------------------------
// Reward slots
// ---------------------------------------------------------------------------

export type SlotStatus = 'FREE' | 'RESERVED' | 'CONSUMED' | 'BROKEN';

export interface RewardSlot {
  id: string;
  channelId: string;
  /** 1..poolSize */
  index: number;
  twitchRewardId: string;
  status: SlotStatus;
  quoteId: string | null;
  reservedForUserId: string | null;
  currentTitle: string;
  currentCost: number;
  enabled: boolean;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Twitch
// ---------------------------------------------------------------------------

export type ExtRole = 'broadcaster' | 'moderator' | 'viewer' | 'external';

export interface ExtIdentity {
  channelId: string;
  /** Always present: opaque per-channel id (prefixed `U` once linked). */
  opaqueUserId: string;
  /** Real Twitch user id, only after identity link / requestIdShare. */
  userId: string | null;
  role: ExtRole;
  expSeconds: number;
  isUnlinked: boolean;
}

export interface RedemptionEvent {
  eventId: string;
  redemptionId: string;
  broadcasterUserId: string;
  userId: string;
  userLogin: string;
  userName: string;
  rewardId: string;
  rewardTitle: string;
  rewardCost: number;
  userInput: string;
  status: string;
  redeemedAt: string;
}

// ---------------------------------------------------------------------------
// Realtime events (socket.io)
// ---------------------------------------------------------------------------

export interface SnapshotPayload {
  channelId: string;
  serverTime: number;
  waypointsOpen: boolean;
  gps: PublicGps | GpsState;
  activeWaypoint: ActiveWaypointView | null;
  settings?: Partial<ChannelSettings>;
}

export interface RealtimeEvents {
  'state:snapshot': SnapshotPayload;
  'gps:update': PublicGps | GpsState;
  'gps:stale': { ageMs: number | null };
  'waypoint:quoted': { quoteId: string; code: string; destinationName: string; cost: number };
  'waypoint:awaiting_payment': { quoteId: string; code: string; rewardTitle: string; cost: number };
  'waypoint:activated': ActiveWaypointView;
  /** `quoteId` lets a viewer whose purchase went unanswered recognise its own job. */
  'waypoint:completed': { id: string; quoteId: string; destinationName: string };
  /** The ACTIVE job was cancelled. Clients clear their waypoint on this one. */
  'waypoint:canceled': { id: string; quoteId: string | null; reason: string };
  /**
   * A quote died before it was ever paid for (expired, superseded, someone
   * else paid first). Deliberately NOT `waypoint:canceled`: a losing quote
   * must never blank the running job on the OBS HUD or the streamer's phone.
   */
  'quote:canceled': { quoteId: string; reason: string };
  'route:update': {
    liveRouteGeometry: string | null;
    remainingDistanceMeters: number | null;
    remainingDurationSeconds: number | null;
  };
  'settings:update': ChannelSettings;
  'reward:redeemed': { quoteId: string; userId: string; cost: number };
  'reward:refunded': { quoteId: string | null; userId: string; reason: string };
  'slots:update': { free: number; total: number };
  /**
   * Only ever sent to the one viewer whose wallet changed (emitToViewer). A
   * signal, not a source of truth: the client re-reads GET /api/ext/wallet.
   */
  'wallet:updated': {
    type: WalletTransactionType;
    amount: number;
    balance: number;
    transactionId: string;
  };
  'waypoint:purchased': {
    waypointId: string;
    quoteId: string;
    userId: string;
    cost: number;
    currency: 'GTA_DOLLAR';
  };
}

export type RealtimeEventName = keyof RealtimeEvents;

// ---------------------------------------------------------------------------
// Viewer-facing API results
// ---------------------------------------------------------------------------

/** Newest waypoint of the channel (any status), without the buyer. Panel only. */
export interface LastWaypointView {
  destinationName: string;
  destination: LatLng;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELED';
  distanceMeters: number;
  activatedAt: number;
  finishedAt: number | null;
}

export interface ViewerStatePayload {
  channelId: string;
  serverTime: number;
  waypointsOpen: boolean;
  gps: PublicGps;
  activeWaypoint: ActiveWaypointView | null;
  identityLinked: boolean;
  limits: {
    maxWalkingDistanceMeters: number;
    quoteTtlSeconds: number;
  };
  slots: { free: number; total: number };
  paymentMode: PaymentMode;
  economy: EconomyInfo;
  /** Absent from servers older than the Panel. */
  lastWaypoint?: LastWaypointView | null;
}

export interface SearchResult {
  id: string;
  name: string;
  category: string | null;
  address: string | null;
  lat: number;
  lng: number;
  /** Straight-line metres from the streamer; a hint only, never the price. */
  approxDistanceMeters: number | null;
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'needs_id_share'
  | 'needs_login'
  | 'insufficient_funds'
  | 'price_changed'
  | 'payment_mode'
  | 'rate_limited'
  | 'gps_unavailable'
  | 'waypoints_closed'
  | 'waypoint_active'
  | 'no_walking_route'
  | 'too_far_from_walkable'
  | 'out_of_bounds'
  | 'restricted_zone'
  | 'too_far'
  | 'no_free_slots'
  | 'quote_not_found'
  | 'quote_expired'
  | 'quote_conflict'
  | 'invalid_request'
  | 'provider_error'
  | 'not_found'
  | 'internal';

export interface ApiError {
  error: ApiErrorCode;
  message: string;
  details?: unknown;
}

