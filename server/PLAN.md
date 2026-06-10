# Plano: Implementar Opção B — Redesign Aba Config / Receitas

## Objetivo
Transformar a tela de configuração de templates de receita na **Opção B** do mockup: cards com preview ao vivo, busca inline de medicações, badges "dose auto", e seção colapsável de override.

## Escopo

### 1. Frontend — popup.src.js + popup.html + sidepanel.html

#### 1.1 Redesenhar `renderRxTemplates()` (popup.src.js)
- **Layout por cartão**: grid de 2 colunas — preview (esquerda, ~170px) + editor (direita, flex)
- **Preview ao vivo**: mini-pill mostrando nome + subtítulo auto-gerado (med count, dias)
- **Pills de medicação**: cada med mostra nome + badge "dose auto" ou "override"
- **Busca inline**: input + dropdown dentro de cada cartão (substitui modal separado)
- **Ajustes manuais**: `<details>` com grid 3-colunas (dose, freq, dur) — só preencher se quiser ignorar catálogo
- **Texto extra**: `<details>` com textarea de variáveis
- **Remover botão ×**: no canto superior direito do cartão

#### 1.2 Substituir modal por busca inline
- Manter o modal HTML como fallback, mas escondê-lo por padrão
- Novo fluxo: digita no input inline → dropdown filtra → clica para adicionar
- Implementar debounce na busca (120ms)
- Dropdown mostra: nome, categoria (PED/ADULTO · tipo), e dose prática do catálogo

#### 1.3 CSS — popup.html / sidepanel.html
- Novas classes: `.rx-card-b`, `.rx-preview-col`, `.rx-editor-col`, `.rx-med-pill`, `.rx-inline-dropdown`, `.rx-override-grid`
- Reutilizar variáveis de cor existentes (dark theme)
- Garantir que funcione tanto no popup quanto no sidepanel

#### 1.4 Eventos — sidepanel-prontuario.js
- Delegação de cliques já existe; adicionar handlers para:
  - `.rx-inline-search` input
  - `.rx-inline-dropdown-item` click
  - `.rx-toggle-override` details toggle
- `_onAddTemplate()` continua criando card vazio; renderização é no popup.src.js

### 2. Backend — dashboard/routes.py

#### 2.1 Adicionar medicações ao catálogo pediátrico
- **Desloratadina xarope** (0.5mg/mL, dose 0.25mg/kg/dia, 1x/dia)
- **Loratadina xarope** (1mg/mL, dose 0.2mg/kg/dia, 1x/dia)
- Verificar se há outras meds comuns faltantes (consultar user se necessário)

#### 2.2 Verificar `/api/dosages/full`
- Endpoint já retorna `_calculate_full_dosages()` + `_calculate_adult_dosages()`
- Novas meds aparecerão automaticamente na resposta
- Garantir que `type=both` inclui ambas as listas

### 3. Testes

- `test-atestado.js`: garantir que não quebrou nada no sidepanel
- `test-prescription-simples.js`: verificar fluxo de receita simples
- Teste manual: abrir config, adicionar modelo, buscar medicação, ver preview

### 4. Commit / Push / Merge

- Commit atomizado: frontend + backend separados
- Push para origin/main
- Sync no Mac Mini

## Arquivos modificados
- `popup/popup.src.js` — renderização dos cards
- `popup/popup.html` — CSS novo + estrutura inline search
- `sidepanel/sidepanel.html` — CSS novo (compartilhado)
- `sidepanel/sidepanel-prontuario.js` — event delegation novos elementos
- `backend/emr_automation/dashboard/routes.py` — novas meds no catálogo
- `popup/popup.bundle.js` — rebuild após alterações

## Estimativa
- Frontend redesign: 3–4h
- Backend meds: 30min
- Testes + ajustes: 1h
- Total: ~5h
