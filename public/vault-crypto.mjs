const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const base64 = value => btoa(Array.from(new Uint8Array(value), n => String.fromCharCode(n)).join(''));
export async function deriveKey(password, salt) {
  if (typeof password !== 'string' || password.length < 10) throw Error('Use uma senha com pelo menos 10 caracteres.');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt:bytes(salt), iterations:600000, hash:'SHA-256'}, material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
}
export const newSalt = () => base64(crypto.getRandomValues(new Uint8Array(16)));
export async function seal(data, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('store-cloner-vault-v1')}, key, new TextEncoder().encode(JSON.stringify(data)));
  return {version:1,salt,iv:base64(iv),body:base64(body)};
}
export async function open(envelope, password) {
  if(envelope?.version!==1 || typeof envelope.salt!=='string' || typeof envelope.iv!=='string' || typeof envelope.body!=='string' || envelope.body.length>2000000) throw Error('Arquivo de cadastro inválido.');
  const key = await deriveKey(password,envelope.salt);
  try {
    const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv),additionalData:new TextEncoder().encode('store-cloner-vault-v1')},key,bytes(envelope.body));
    const data=JSON.parse(new TextDecoder().decode(plain));
    if(!Array.isArray(data.stores)||data.stores.some(s=>!s.id||!s.name||!s.shop||!s.clientId||!s.clientSecret))throw Error();
    return {key,data};
  } catch {throw Error('Senha incorreta ou arquivo danificado.');}
}
