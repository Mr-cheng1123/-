import type {LiveExchangeReadiness} from '../../src/shared/types';

/** Current server state, rather than an earlier check receipt, owns each card. */
export function accountExecutionPermission(venue:LiveExchangeReadiness|undefined,readinessKnown:boolean):{label:string;authorized:boolean}{
  if(!readinessKnown)return {label:'授权待同步',authorized:false};
  if(!venue)return {label:'未启用',authorized:false};
  if(!venue.credentialsConfigured)return {label:'未配置',authorized:false};
  if(venue.supported===false)return {label:'未启用',authorized:false};
  if(venue.executionAuthorized===true)return {label:'会话已授权',authorized:true};
  if(venue.executionAuthorized===undefined)return {label:'授权待同步',authorized:false};
  return {label:'待提交前授权',authorized:false};
}
