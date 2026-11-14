import {AsyncLocalStorage} from 'node:async_hooks';

const storage=new AsyncLocalStorage();

export function withCorrelation(correlationId,callback){
  return storage.run({correlationId:String(correlationId)},callback);
}

export function getCorrelationId(){
  return storage.getStore()?.correlationId??null;
}
