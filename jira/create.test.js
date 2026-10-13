import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiraProvider } from './provider.js';
import { fieldSchema } from './model.js';

const account = { id: 'review', host: 'https://jira.example.invalid', kind: 'basic' };
const ok = (json) => ({status: 200, json});

// Catches: configured project and chosen issue type are presented as required empty controls.
test('create_omits_project_and_type_supplied_by_the_provider', async () => {
 const provider = createJiraProvider({account, projectId: '10000', fetch: async () => ok({isLast:true, fields:[
  {fieldId:'project', name:'Project', required:true, schema:{type:'project'}},
  {fieldId:'issuetype', name:'Issue Type', required:true, schema:{type:'issuetype'}},
  {fieldId:'reporter', name:'Reporter', required:true, schema:{type:'user'}},
 ]})});
 assert.deepEqual((await provider.createFields('10002')).map(f => f.id), ['reporter']);
});

// Catches: assignee search uses global users, DC sends query instead of username, or user IDs are discarded.
for (const kind of ['basic', 'bearer']) test(`user_search_${kind}_uses_provider_ids_and_project_scope`, async () => {
 const paths = [];
 const provider = createJiraProvider({account:{...account, kind}, projectId:'10000', fetch: async req => {
  paths.push(new URL(req.url));
  return ok([{accountId:'cloud-user', name:'dc-user', displayName:'Reviewer', active:true}, {accountId:'inactive', name:'inactive', active:false}]);
 }});
 assert.deepEqual(await provider.lookupUsers('assignee', ' Review & '), [{id:kind === 'basic' ? 'cloud-user' : 'dc-user',name:'Reviewer'}]);
 assert.equal(paths[0].pathname, `/rest/api/${kind === 'basic' ? 3 : 2}/user/assignable/search`);
 assert.equal(paths[0].searchParams.get('project'), '10000');
 assert.equal(paths[0].searchParams.get(kind === 'basic' ? 'query' : 'username'), 'Review &');
 await provider.lookupUsers('reporter', 'Review');
 assert.equal(paths[1].pathname.endsWith('/user/search'), true);
 assert.equal(paths[1].searchParams.has('project'), false);
 assert.deepEqual(await provider.lookupUsers('assignee', '  '), []);
 assert.equal(paths.length, 2);
});

// Catches: allowed users become enums using an undefined ID instead of Cloud accountId.
test('allowed_users_keep_user_kind_and_account_ids', () => {
 assert.deepEqual(fieldSchema({fieldId:'reporter',name:'Reporter',schema:{type:'user'},allowedValues:[{accountId:'cloud-user',displayName:'Reviewer'}]}), {
  id:'reporter',name:'Reporter',kind:'user',required:false,editable:true,options:[{id:'cloud-user',name:'Reviewer'}],
 });
});

// Catches: a required field Jira fills itself (Reporter) is forced on the user as an empty blocker.
test('field_with_a_jira_default_is_not_required', () => {
 const field = {fieldId:'reporter',name:'Reporter',required:true,schema:{type:'user'}};
 assert.equal(fieldSchema({...field, hasDefaultValue:true}).required, false);
 assert.equal(fieldSchema({...field, hasDefaultValue:false}).required, true);
 assert.equal(fieldSchema(field).required, true);
});

// Catches: empty optional fields are sent as null, which overrides defaults Jira would apply.
test('create_omits_empty_optional_fields_from_the_payload', async () => {
 let body;
 const provider = createJiraProvider({account, projectId:'10000', fetch: async (req) => {
  if (req.method === 'POST') { body = req.body; return ok({key:'LAN-1'}); }
  if (new URL(req.url).pathname.includes('/createmeta/')) return ok({isLast:true, fields:[
   {fieldId:'summary', name:'Summary', required:true, schema:{type:'string'}},
   {fieldId:'assignee', name:'Assignee', required:false, schema:{type:'user'}},
   {fieldId:'labels', name:'Labels', required:false, schema:{type:'array', items:'string'}},
  ]});
  throw new Error('stop after create');
 }});
 await provider.act(null, {kind:'create', value:{title:'T', body:'', itemType:'10002', fields:{assignee:null, labels:null}}}).catch(() => {});
 assert.deepEqual(Object.keys(body.fields).sort(), ['description', 'issuetype', 'project', 'summary']);
});
