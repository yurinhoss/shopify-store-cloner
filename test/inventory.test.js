import test from 'node:test';
import assert from 'node:assert/strict';
import {stockQuantity,setProductStock} from '../lib/inventory.js';
const level=quantity=>({id:'level',quantities:[{name:'available',quantity}]});
test('stock is validated before API calls, including zero and fractional input',async()=>{
 assert.equal(stockQuantity('0'),0);assert.equal(stockQuantity(25),25);
 for(const v of ['',null,undefined,true,-1,1.5,'5.5','abc',Infinity,2147483648])assert.throws(()=>stockQuantity(v));
 let calls=0;await assert.rejects(setProductStock(async()=>{calls++},[{inventory_item_id:1}],2,-1));assert.equal(calls,0);
});
test('2026-07 inventory contract uses CAS and idempotency, updates zero, and checks userErrors',async()=>{
 const mutations=[];
 const call=async(q,v)=>{
  if(q.includes('query ImportInventory'))return {nodes:v.ids.map(id=>({id,tracked:true,inventoryLevel:level(9)}))};
  assert.match(q,/@idempotent\(key:\$key\)/);assert.ok(v.key);
  assert.deepEqual(Object.keys(v.input).sort(),['name','quantities','reason','referenceDocumentUri']);
  mutations.push(v);return {inventorySetQuantities:{userErrors:[]}};
 };
 await setProductStock(call,[{inventory_item_id:12}],34,0);
 assert.deepEqual(mutations[0].input.quantities,[{inventoryItemId:'gid://shopify/InventoryItem/12',locationId:'gid://shopify/Location/34',quantity:0,changeFromQuantity:9}]);
 await assert.rejects(setProductStock(async(q,v)=>q.includes('query ImportInventory')?{nodes:v.ids.map(id=>({id,tracked:true,inventoryLevel:level(9)}))}:{inventorySetQuantities:{userErrors:[{field:['quantities'],message:'Stale quantity',code:'CHANGE_FROM_QUANTITY_STALE'}]}},[{inventory_item_id:12}],34,3),/Stale quantity/);
});
test('untracked and unstocked variants are enabled at the selected location before setting stock',async()=>{
 const operations=[];
 await setProductStock(async(q,v)=>{
  if(q.includes('query ImportInventory'))return {nodes:[{id:v.ids[0],tracked:false,inventoryLevel:null}]};
  if(q.includes('ImportTrack')){operations.push('track');return {inventoryItemUpdate:{userErrors:[]}};}
  if(q.includes('ImportActivate')){operations.push('activate');assert.match(q,/@idempotent/);return {inventoryActivate:{inventoryLevel:level(0),userErrors:[]}};}
  operations.push('set');assert.equal(v.input.quantities[0].changeFromQuantity,0);return {inventorySetQuantities:{userErrors:[]}};
 },[{inventory_item_id:1}],2,100);
 assert.deepEqual(operations,['track','activate','set']);
});
test('large variant sets use bounded batches and do not reuse idempotency keys',async()=>{
 const sizes=[],keys=[];
 await setProductStock(async(q,v)=>{
  if(q.includes('query ImportInventory'))return {nodes:v.ids.map(id=>({id,tracked:true,inventoryLevel:level(0)}))};
  sizes.push(v.input.quantities.length);keys.push(v.key);return {inventorySetQuantities:{userErrors:[]}};
 },Array.from({length:251},(_,i)=>({inventory_item_id:i+1})),2,3);
 assert.deepEqual(sizes,[100,100,51]);assert.equal(new Set(keys).size,3);
});
