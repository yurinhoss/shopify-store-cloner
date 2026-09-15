# Revisão do Store Cloner — 15/09/2026

Base analisada: `b4354b36d8ba1f96a6ad06264e8072ef8fe1aba1`.

## Design

Interface alinhada ao Ponte Checkout (`painel/dashboard.html`) e ao YDE Dash (`public/css/ponte.css`): navegação lateral de 246 px, superfícies claras, azul, cards arredondados e console escuro. Menu horizontal com rolagem no celular, títulos por aba, foco visível e rótulos associados aos campos. As configurações de Markets e fretes existentes foram preservadas.

## Falhas corrigidas

- Paginação REST repetia indefinidamente a mesma página após cinco respostas 429. Agora encerra com erro, limita as tentativas e aplica timeout por requisição. Links seguintes precisam permanecer na mesma origem.
- Clonagem e importação podiam encerrar a conexão sem evento final e aparentar conclusão. O leitor compartilhado exige conclusão explícita, propaga erros e trata caracteres UTF-8 divididos entre pacotes.
- Importação emitia erro fatal apenas como texto no log. Agora emite evento de erro; sucesso tem evento de conclusão próprio.
- Clonagem aceita apenas lojas diferentes, credenciais completas e alguma opção selecionada. Domínios usados na autenticação passam pela validação já existente do planner.
- Valor zero no frete era substituído pelo padrão pelo operador `||`. Agora zero é preservado e valores inválidos são rejeitados quando a clonagem de fretes está selecionada.
- Uma nova execução reaproveitava indicadores antigos. Barra e checklist são reinicializados, e alterações de credenciais invalidam o indicador de conexão.
- Pendências registradas como erro na clonagem passam a aparecer no texto de conclusão.
- Títulos e links do checklist são tratados antes de entrar no HTML.
- Reset chamava `/api/reset-start` e `/api/clone-status`, ausentes no servidor. Os controles quebrados foram removidos e a aba explica a indisponibilidade. Este PR não implementa exclusão de dados.

## Validação

- 18 testes Node passaram: 11 testes existentes de Markets/fretes e 7 novos testes de streaming/paginação.
- Sintaxe do servidor, scripts externos e JavaScript inline verificada.
- Servidor iniciado localmente: payload vazio e origem igual ao destino retornam HTTP 400 antes de chamar a Shopify.
- Navegador Chromium: seis abas navegáveis sem erros JavaScript; viewport de 390 px sem overflow horizontal. Capturas de desktop (1440 px) e celular inspecionadas.
- Nenhuma clonagem ou alteração foi executada em lojas reais.

## Melhorias que permanecem

- Jobs persistentes e retomada após reinício: clonagem/importação ainda dependem da conexão aberta e não possuem histórico durável.
- Autenticação do painel e controle de acesso: o servidor atual não implementa login próprio.
- O importador informa no próprio código que coleções públicas criadas não recebem automaticamente seus produtos; implementar esse vínculo exige uma etapa adicional.
- Upload de arquivos precisa de validação integrada em uma loja de teste: o helper atual tenta enviar `data:` como `originalSource` e descarta falhas; este fluxo não foi refeito aqui.
- A conclusão com pendências considera mensagens marcadas como erro; o app ainda não oferece resumo estruturado de sucesso/falha para cada recurso.


## Restauração do reset

Recuperado do commit `2dfaedf17e12cac02cd9417b0b8ed9e069f3d874` após revisão do histórico. As oito etapas voltaram ao layout atual; `/api/reset-start` agora transmite SSE diretamente para o novo cliente. Exige confirmação do domínio no servidor, rejeita opções desconhecidas e bloqueia resets simultâneos para a mesma loja neste processo. Nenhuma exclusão é iniciada automaticamente.

Markets usa `primaryMarket { id }`, ainda disponível na API 2026-07, em vez do campo antigo `Market.primary`; Markets e menus são paginados. Arquivos interrompem a operação se a leitura de imagens de produtos falhar. Fretes mantém o comportamento histórico: apenas zonas com nome de duas letras no perfil geral; se um grupo exceder a página suportada, interrompe sem excluir suas zonas. A proteção de arquivos cobre imagens, não vídeos vinculados aos produtos; a interface informa que arquivos usados no tema podem ser excluídos.

Fontes de compatibilidade: https://shopify.dev/docs/api/admin-graphql/latest/queries/primaryMarket e https://shopify.dev/docs/api/admin-graphql/latest/objects/Menu.

Validação com respostas simuladas, sem exclusões em lojas reais: confirmação obrigatória, exclusão limitada ao destino e à seleção, preservação do mercado principal e de menus padrão, proteção de imagens, falhas parciais e endpoint SSE.

Resultado da restauração: 26 testes passaram. Chromium em 390 px validou oito opções, cancelamento sem requisição, envio apenas das etapas selecionadas, conclusão SSE simulada e ausência de erros JavaScript/overflow horizontal.
