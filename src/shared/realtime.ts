import type {BookLevel,ExchangeId} from './types.js';

/** In-memory observations only; neither a receipt nor an authorization to trade. */
export interface RealtimeBook {
  exchange:ExchangeId;symbol:string;bids:BookLevel[];asks:BookLevel[];
  receivedAt:number;eventAt?:number;generation:number;sequence?:number|string;
}
export interface RealtimeStreamStatus {
  exchange:ExchangeId;kind:'public'|'private';
  state:'connecting'|'online'|'degraded'|'offline'|'disabled';
  subscriptions:number;lastEventAt:number;reconnects:number;error?:string;
  /** Safe private transport diagnostics only, never native messages or trading permission. */
  failureCode?:'REGION_BLOCKED'|'ACCESS_DENIED'|'PROXY_UNAVAILABLE'|'RATE_LIMITED'|'TIMEOUT'|'DNS_ERROR'|'TLS_ERROR'|'NETWORK_ERROR'|'API_ERROR'|'SOCKET_CLOSED';
  failureStage?:'initialization'|'orders'|'trades'|'socket-error'|'socket-close'|'send';
  closeCode?:number;
  /** Public book availability only; a quiet symbol need not mean the transport disconnected. */
  freshBooks?:number;
}
export interface ExecutionLatencyEvent {
  positionId:string;base:string;
  phase:'first-submit'|'first-confirmed'|'hedge-submit'|'hedge-confirmed'|'matched'|'finished';
  at:number;batch?:number;
}
export interface RealtimeStatus {
  enabled:boolean;eventTriggered:boolean;
  streams:RealtimeStreamStatus[];
  books:number;lastQuoteAt:number;lastSignalAt:number;
  /** Observation plan only. Venue permissions and order eligibility remain independent. */
  focus?:RealtimeFocusStatus;
  latency:{samples:number;firstLegMs?:number;hedgeMs?:number;matchedMs?:number;p95HedgeMs?:number;p95MatchedMs?:number};
}
export interface RealtimeFocusStatus {
  changedAt:number;nextRotationAt:number;generation:number;deferredCount:number;deferredExamples:string[];overflow?:string;
  venues:Array<{exchange:ExchangeId;limit:number;bases:string[];
    entries:Array<{base:string;reason:string;selectedAt:number;rotating:boolean;pairKeys:string[]}>;
    /** Genuine funding metadata, separate from raw WS depth and private fee evidence. */
    metadata:{fresh:number;total:number;pendingBases:string[];lastAttemptAt:number;lastSuccessAt:number}}>; 
}
