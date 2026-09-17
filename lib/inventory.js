import { randomUUID } from 'node:crypto';
import { checkPayload } from './planner.js';
export function stockQuantity(value) {
  if(value === '' || value == null || !['number','string'].includes(typeof value)) throw new Error('Informe um estoque inteiro maior ou igual a zero.');
  const quantity=Number(value);
  if(!Number.isSafeInteger(quantity)||quantity<0||quantity>2147483647) throw new Error('Estoque deve ser um inteiro entre 0 e 2147483647.');
  return quantity;
}
const gid=(type,value)=> {
  const id=String(value??'');
  if(new RegExp(`^gid://shopify/${type}/[0-9]+$`).test(id))return id;
  if(!/^[0-9]+$/.test(id))throw new Error(`ID de ${type} inválido.`);
  return `gid://shopify/${type}/${id}`;
};
export async function setProductStock(call,variants,location,requested) {
  const quantity=stockQuantity(requested),locationId=gid('Location',location);
  if(!variants?.length)throw new Error('Produto sem variantes para ajustar estoque.');
  const ids=[...new Set(variants.map(v=>gid('InventoryItem',v.inventory_item_id)))];
  // Read actual available quantities for CAS; never overwrite intervening sales.
  for(let offset=0;offset<ids.length;offset+=100){
    const slice=ids.slice(offset,offset+100);
    const data=await call(`query ImportInventory($ids:[ID!]!,$locationId:ID!){nodes(ids:$ids){... on InventoryItem{id tracked inventoryLevel(locationId:$locationId){id quantities(names:["available"]){name quantity}}}}}`,{ids:slice,locationId});
    if(data.nodes?.length!==slice.length)throw new Error('Leitura de estoque incompleta.');
    const quantities=[];
    for(const item of data.nodes){
      if(!item?.id)throw new Error('Item de estoque não encontrado.');
      if(!item.tracked)checkPayload((await call(`mutation ImportTrack($id:ID!,$input:InventoryItemInput!){inventoryItemUpdate(id:$id,input:$input){inventoryItem{id} userErrors{field message}}}`,{id:item.id,input:{tracked:true}})).inventoryItemUpdate,'inventoryItemUpdate');
      let level=item.inventoryLevel;
      if(!level)level=checkPayload((await call(`mutation ImportActivate($item:ID!,$location:ID!,$key:String!){inventoryActivate(inventoryItemId:$item,locationId:$location) @idempotent(key:$key){inventoryLevel{id quantities(names:["available"]){name quantity}} userErrors{field message}}}`,{item:item.id,location:locationId,key:randomUUID()})).inventoryActivate,'inventoryActivate').inventoryLevel;
      const current=level?.quantities?.find(q=>q.name==='available')?.quantity;
      if(!Number.isInteger(current))throw new Error('Quantidade atual indisponível; ajuste cancelado.');
      quantities.push({inventoryItemId:item.id,locationId,quantity,changeFromQuantity:current});
    }
    const key=randomUUID();
    checkPayload((await call(`mutation ImportSetStock($input:InventorySetQuantitiesInput!,$key:String!){inventorySetQuantities(input:$input) @idempotent(key:$key){inventoryAdjustmentGroup{createdAt} userErrors{field message code}}}`,{key,input:{name:'available',reason:'correction',referenceDocumentUri:`gid://store-cloner/Import/${key}`,quantities}})).inventorySetQuantities,'inventorySetQuantities');
  }
  return ids.length;
}
