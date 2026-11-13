'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSameOriginGuard } = require('../src/security');

function invoke({method='POST',path='/api/admin/action',origin='https://example.com',host='example.com',fetchSite='same-origin'}={}) {
  const req={method,path,headers:{origin,host,'sec-fetch-site':fetchSite},get(name){return this.headers[name.toLowerCase()]}};
  let nextCalled=false, statusCode=200, body='';
  const res={status(code){statusCode=code;return this;},send(value){body=value;return this;}};
  createSameOriginGuard()(req,res,()=>{nextCalled=true;});
  return {nextCalled,statusCode,body};
}

test('same-origin guard allows same-origin browser mutations',()=>{
  assert.equal(invoke().nextCalled,true);
});
test('same-origin guard rejects cross-origin and missing Origin mutations',()=>{
  assert.equal(invoke({origin:'https://evil.example'}).statusCode,403);
  assert.equal(invoke({origin:''}).statusCode,403);
  assert.equal(invoke({fetchSite:'cross-site'}).statusCode,403);
});
test('same-origin guard allows safe methods and Telegram webhook delivery',()=>{
  assert.equal(invoke({method:'GET',origin:''}).nextCalled,true);
  assert.equal(invoke({method:'POST',path:'/telegram/secret',origin:''}).nextCalled,true);
});
