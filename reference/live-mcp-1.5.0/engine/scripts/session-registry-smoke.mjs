import assert from 'node:assert/strict';
import { touchSession, listSessions, disconnectSession, disconnectClientSessions } from '../src/services/session-registry-service.js';

const identity={userId:'user-1',username:'Tester',role:'user'};
touchSession({sessionId:'s1',clientId:'client-a',identity,conversationId:'c1',maxActiveSessionsPerClient:2,idleMinutes:60});
touchSession({sessionId:'s2',clientId:'client-a',identity,conversationId:'c2',maxActiveSessionsPerClient:2,idleMinutes:60});
assert.equal(listSessions({clientId:'client-a'}).length,2);
let limitError=null;
try{touchSession({sessionId:'s3',clientId:'client-a',identity,conversationId:'c3',maxActiveSessionsPerClient:2,idleMinutes:60});}catch(error){limitError=error;}
assert.equal(limitError?.code,'SESSION_LIMIT_REACHED');
const blocked=disconnectSession('s1','test');
assert.equal(blocked?.status,'blocked');
let blockedError=null;
try{touchSession({sessionId:'s1',clientId:'client-a',identity,conversationId:'c1',maxActiveSessionsPerClient:2,idleMinutes:60});}catch(error){blockedError=error;}
assert.equal(blockedError?.code,'SESSION_BLOCKED');
const remaining=listSessions({clientId:'client-a'});
assert.deepEqual(remaining.map((item)=>item.id),['s2']);
const disconnected=disconnectClientSessions('client-a','client_test');
assert.equal(disconnected.length,2);
assert.equal(listSessions({clientId:'client-a'}).length,0);
assert.equal(listSessions({clientId:'client-a',includeInactive:true}).length,2);
console.log(JSON.stringify({ok:true,checks:8,coverage:['multi-session','per-client-limit','session-block','client-disconnect']}));
