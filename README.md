# Shopify Store Cloner

Node.js 24.x, zero runtime dependencies beyond Express — the built-in `fetch` is used directly. The Admin API version is set once in `server.js` (`API_VERSION`); review it every quarter, since Shopify supports each version for about 12 months and silently serves a newer one after that.

Node.js 24.x. Start with `npm start`; run the local tests with `node --test`.

## Markets and shipping planner

Fill in **Destination Store** credentials, then open **Markets** or **Fretes**. The source store is not used by these tabs.

1. Select a region, the whole world, or individual countries. The 50 excluded countries are enforced by the server as well as the interface. Existing configurations in excluded countries are not deleted.
2. Generate a preview. Markets reads **that destination's published locales**, every time, and picks the language **automatically**: the country's own language when it is published in that store, otherwise English. Portuguese from Portugal is never silently replaced with Brazilian Portuguese — a mismatch falls back to English and says so in the preview. Nothing has to be selected by hand; a per-country override is still available in the table. English must itself be published: if it is not, the preview blocks and asks you to publish it. The tool does not create translations or publish languages.
3. Markets creates or updates an individual country market with an explicit baseCurrency (Germany = EUR) and localCurrencies=false. Country currency labels and language defaults are suggestions, not a guarantee of payment-provider availability. Shopify restrictions and plan limits are reported per country. Language defaults use Node's ICU likely-subtag data and can be overridden; they are not a demographic survey of multilingual countries.
4. A dedicated country subfolder (such as `/en-pt`) assigns the reviewed primary locale and English. Existing shared web presences are not modified. Orphaned country subfolders or those owned only by the selected market are repaired; conflicting shared subfolders remain protected. Association uses webPresencesToAdd/webPresencesToDelete and the returned currency, locales and URLs are checked before reporting success.
5. Fretes uses €4.90 standard and €7.90 express by default. Preview obtains the exchange rate to the **store currency** from Frankfurter; unsupported currencies or network failures require a manual rate. The rate and date are shown and held for the reviewed operation. JPY and other currencies use their currency precision. Carrier names are editable labels, not carrier contracts or calculated shipping integrations. Unknown carriers use generic Standard/Express Shipping labels.
6. Select the shipping profile and fulfillment location group. Existing individual zones and same-name rates are updated. Unrelated rates are preserved. Grouped zones and Rest of World coverage are flagged for manual separation before a country-specific change, rather than rewriting their other countries.
7. Review and apply. The server reads the destination again, validates errors, prevents simultaneous planner runs for one shop in this process, and reports success/failure per country. A disconnected run may have applied earlier countries: generate a new preview before repeating.

Preview IDs expire in 15 minutes and are held in memory; use one app instance. A deployment/restart invalidates pending previews. No destination credentials or access tokens are stored in preview records. Requests still require the destination credentials already used by the app.

Required app access: `read_markets`, `write_markets`, `read_locales`, `read_shipping`, `write_shipping`, and `read_locations` as applicable. The planner uses Admin GraphQL **2026-07**. Legacy cloning remains separate; this change fixes its frontend route mismatch, applies country exclusions to its country lists, and honors the shipping-price fields with current/manual-safe conversion instead of fixed historical exchange rates.

## Validation

`node --test` covers exclusions, different destination locales, unpublished locales, Portuguese variants, automatic English fallback, currency precision, market pagination, read-only previews, grouped zones, reuse of existing rates/web presences, and HTTP apply error/replay handling. These tests use simulated Shopify responses. Real-store credentials were not supplied for live Shopify writes. Browser rendering was not verified because Chromium is not installed in the development environment.

API references:
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/MarketCreateInput
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/MarketUpdateInput
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/webPresenceCreate
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/DeliveryProfileInput


## Correções de compatibilidade (2026-09-16)

- Estoque usa `changeFromQuantity` com a quantidade lida (CAS), `@idempotent` com chave por ajuste e valida `userErrors`. Variantes sem rastreamento/local são habilitadas antes do ajuste. Estoque zero é válido.
- Importação mantém um heartbeat e apresenta erros completos. Produtos criados cujo estoque falhou são reportados como pendentes. Para reparar: marque **Corrigir estoque dos já importados**, mantenha a mesma URL e tag de importação e informe o estoque desejado. A correção exige título, handle e tag únicos; produtos ambíguos são preservados. Não recria produtos existentes nem modifica seus preços.
- Duplicados agora são consultados em todas as páginas. Em Markets, quando houver mercados duplicados por país, a prévia permite selecionar qual corrigir.
- A prévia mostra moeda explícita e caminhos por idioma. Quando não há moeda mapeada/suportada, escolha uma moeda da lista da API. Idiomas seguem os publicados na loja; configurar idiomas não traduz conteúdo.

Contratos: https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryQuantityInput e https://shopify.dev/docs/api/admin-graphql/latest/input-objects/MarketUpdateInput .


## Gerador de políticas

A aba Políticas gera sete textos para produtos físicos e compras avulsas: frete, devoluções, privacidade, termos de serviço, termos de venda, contato e aviso legal. Europa/mundo usam inglês; Japão usa japonês. Dados principais da empresa e prazo de devolução são informados uma vez. Ajustes opcionais mostram as sugestões operacionais; devem corresponder à operação real. Não é uma garantia de conformidade jurídica global, nem configuração de consentimento de cookies ou tradução automática por Markets.

A prévia lê as políticas existentes e é válida por 30 minutos. A publicação exige confirmação do destino e substitui apenas os tipos selecionados. Uma leitura nova impede sobrescrever mudanças feitas depois da prévia. Falhas parciais são mostradas por política; uma nova tentativa exige outra prévia. Permissões: read_legal_policies e write_legal_policies. Nenhuma credencial é guardada no rascunho.

Referências: https://shopify.dev/docs/api/admin-graphql/latest/mutations/shopPolicyUpdate ; https://shopify.dev/docs/api/admin-graphql/latest/enums/ShopPolicyType ; https://europa.eu/youreurope/citizens/consumers/shopping/returns/index_en.htm ; https://europa.eu/youreurope/citizens/consumers/shopping/guarantees/index_en.htm ; https://www.no-trouble.caa.go.jp/what/mailorder/ ; https://www.ppc.go.jp/en/legal/ .

## Minhas lojas e Criador V2

A entrada usa **Criar conta / Entrar** com e-mail e senha (mínimo 10 caracteres). Senhas usam scrypt com salt individual; sessões de 30 dias usam cookie HttpOnly/Secure em produção, token aleatório armazenado por hash, CSRF e limite de tentativas de autenticação. Cada conta só acessa suas conexões e preferências. Não há envio de confirmação ou recuperação por e-mail nesta versão.

**Conectar loja** testa e salva as credenciais Shopify; **Minhas lojas** permite selecionar origem/destino, editar e excluir conexões. Segredos e a chave OpenAI são criptografados com AES-256-GCM no servidor e nunca retornam ao navegador. As ferramentas recebem referências às conexões; o backend resolve essas referências dentro da conta autenticada. O cadastro antigo deste navegador pode ser importado com sua senha anterior.

Produção exige `DATA_DIR` em volume persistente (Railway: `/data`) e `NODE_ENV=production`. SQLite e `credentials.key` ficam nesse diretório, fora do Git. Faça backup do diretório inteiro, incluindo a chave; nunca apague ou substitua a chave separadamente. Mantenha uma única réplica com esse volume. Desenvolvimento usa `./data`. A API pública é limitada a autenticação, health e pacotes temporários de tema necessários para a Shopify.

O Criador V2 mantém as funções anteriores. Permite segmento, marca, domínio de referência, idioma da vitrine (EN/PT/DE/JA), paletas editáveis, direção visual, catálogo completo paginado e sugestões por título/tipo/tags. Projetos e imagens são guardados por conta e domínio Shopify no IndexedDB, separados do cadastro de credenciais. Estes projetos não são criptografados e não contêm credenciais; contêm metadados comerciais do catálogo. A análise do servidor dura quatro horas e é perdida em reinícios; reanalisar mantém as imagens locais. Cada imagem pode ser enviada pelo usuário ou gerada pela API OpenAI com sua própria chave cadastrada na conta, modelo `gpt-image-2`, uma imagem por solicitação. Cada botão solicita somente sua peça (logo, favicon, banner desktop ou mobile), explicitamente sem layouts de página. Referências são opcionais, desativadas por padrão, e restritas à imagem selecionada do mesmo cartão. Não há cobrança de IA sem clicar em gerar; upload e classificação do catálogo não usam IA paga.

Coleções novas recebem handles `v2-*`; as existentes são preservadas. A seleção é explícita e os produtos em rascunho não são ativados. A publicação da coleção usa o canal Online Store / Loja virtual. O estoque é preservado por padrão; a ação opcional exige quantidade/local e confirmação, reutilizando leitura CAS e idempotência do módulo inventory. Criar coleções e ajustar estoque afeta a loja inteira, antes da publicação do tema.

A V2 produz um tema-base próprio (não altera o tema existente), com cabeçalho, rodapé, políticas já existentes, seletor de país/idioma, home, produto/variantes, coleções, busca, sacola e passagem ao checkout. As primeiras 12 coleções selecionadas aparecem na home. Não migra recursos específicos de apps, assinaturas, templates ou traduções de temas anteriores. Nome, textos e cores ficam em settings JSON e são escapados ao renderizar; Liquid nunca é interpolado com dados do usuário. `themeCreate` recebe um ZIP servido por URL aleatória temporária por 30 minutos, sem credenciais. A preparação é assíncrona, verificada antes da publicação separada. Shopify pode exigir autorização especial para acesso de temas, além de `write_themes`; erros são mostrados sem anunciar sucesso. Se hospedado em outro domínio, defina `BUILDER_PUBLIC_URL` com a origem HTTPS pública deste app. A fila de pacotes é em memória (128 MB); tema pendente durante reinício pode precisar ser preparado novamente.

Permissões V2: `read_products`, `write_products`, `read_locations`, `read_inventory`, `write_inventory`, `read_publications`, `write_publications`, `read_themes`, `write_themes`. O domínio de marca informado não é adquirido nem conectado automaticamente. Markets, fretes e políticas mantêm seus fluxos próprios.

Contratos: https://shopify.dev/docs/api/admin-graphql/latest/mutations/themeCreate ; https://shopify.dev/docs/api/admin-graphql/latest/mutations/themePublish ; https://shopify.dev/docs/api/admin-graphql/latest/mutations/collectionCreate ; https://shopify.dev/docs/api/admin-graphql/latest/mutations/collectionAddProducts ; https://developers.openai.com/api/docs/guides/image-generation .
