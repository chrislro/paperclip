// cid.js — Base de dados CID-10 geral (adulto + pediátrico)
// Toca Ficha Dr. Extension
//
// Cada entrada contém:
//   code      : CID-10 padrão com ponto (ex: "J06.9")
//   name      : nome curto para busca fuzzy e exibição
//   emr_id    : ID interno do G-Hosp (code sem ponto, ex: "J069")
//   emr_label : texto exato do autocomplete do G-Hosp (vai para #cid_descricao)
//
// Lista enxuta com diagnósticos mais comuns na UPA / atenção primária.
// Subcategorias foram agrupadas em termos guarda-chuva (ex: "IVAS" cobre
// resfriado, faringite, amigdalite, laringite).

var TOCAFICHADR_CID = [
  // ── Respiratório ──
  { code: "J00",    name: "Resfriado comum",                                          emr_id: "J00",   emr_label: "Nasofaringite aguda [resfriado comum]" },
  { code: "J02.9",  name: "Faringite aguda",                                          emr_id: "J029",  emr_label: "Faringite aguda não especificada" },
  { code: "J03.9",  name: "Amigdalite aguda",                                         emr_id: "J039",  emr_label: "Amigdalite aguda não especificada" },
  { code: "J04.0",  name: "Laringite aguda",                                          emr_id: "J040",  emr_label: "Laringite aguda" },
  { code: "J06.9",  name: "IVAS — Infecção aguda das vias aéreas superiores",         emr_id: "J069",  emr_label: "Infecção aguda das vias aéreas superiores não especificada" },
  { code: "J11.1",  name: "Gripe / Influenza",                                        emr_id: "J111",  emr_label: "Influenza [gripe] com outras manifestações respiratórias, devida a vírus não identificado" },
  { code: "J18.9",  name: "Pneumonia",                                                emr_id: "J189",  emr_label: "Pneumonia não especificada" },
  { code: "J20",    name: "Bronquite aguda",                                          emr_id: "J20",   emr_label: "Bronquite aguda" },
  { code: "J32.9",  name: "Sinusite",                                                 emr_id: "J329",  emr_label: "Sinusite crônica não especificada" },
  { code: "J45.9",  name: "Asma",                                                     emr_id: "J459",  emr_label: "Asma não especificada" },
  { code: "J46",    name: "Estado de mal asmático",                                   emr_id: "J46",   emr_label: "Estado de mal asmático" },

  // ── Gastrointestinal ──
  { code: "A09",    name: "Diarreia / Gastroenterite infecciosa",                     emr_id: "A09",   emr_label: "Diarréia e gastroenterite de origem infecciosa presumível" },
  { code: "K52.9",  name: "Gastroenterite não infecciosa",                            emr_id: "K529",  emr_label: "Gastroenterite e colite não-infecciosas, não especificadas" },
  { code: "R10",    name: "Dor abdominal",                                            emr_id: "R10",   emr_label: "Dor abdominal e pélvica" },
  { code: "R11",    name: "Náusea e vômitos",                                         emr_id: "R11",   emr_label: "Náusea e vômitos" },
  { code: "K59.0",  name: "Constipação",                                              emr_id: "K590",  emr_label: "Constipação" },

  // ── Infeccioso / Febre / Dermatológico ──
  { code: "R50",    name: "Febre",                                                    emr_id: "R50",   emr_label: "Febre de origem desconhecida e de outras origens" },
  { code: "B34.9",  name: "Infecção viral não especificada",                          emr_id: "B349",  emr_label: "Infecção viral não especificada" },
  { code: "A46",    name: "Erisipela",                                                emr_id: "A46",   emr_label: "Erisipela" },
  { code: "L03.9",  name: "Celulite",                                                 emr_id: "L039",  emr_label: "Celulite não especificada" },
  { code: "L30.9",  name: "Dermatite",                                                emr_id: "L309",  emr_label: "Dermatite não especificada" },
  { code: "L01.0",  name: "Impetigo",                                                 emr_id: "L010",  emr_label: "Impetigo [qualquer localização] [qualquer microorganismo]" },
  { code: "B35.9",  name: "Dermatofitose (tinea)",                                    emr_id: "B359",  emr_label: "Dermatofitose não especificada" },
  { code: "L50.9",  name: "Urticária",                                                emr_id: "L509",  emr_label: "Urticária não especificada" },
  { code: "H10.9",  name: "Conjuntivite",                                             emr_id: "H109",  emr_label: "Conjuntivite não especificada" },
  { code: "H66.9",  name: "Otite média",                                              emr_id: "H669",  emr_label: "Otite média não especificada" },

  // ── Neurológico / Dor / Cardiovascular ──
  { code: "R51",    name: "Cefaleia",                                                 emr_id: "R51",   emr_label: "Cefaléia" },
  { code: "G43.9",  name: "Enxaqueca",                                                emr_id: "G439",  emr_label: "Enxaqueca, sem especificação" },
  { code: "R55",    name: "Síncope",                                                  emr_id: "R55",   emr_label: "Síncope e colapso" },
  { code: "G40.9",  name: "Epilepsia / Convulsão",                                    emr_id: "G409",  emr_label: "Epilepsia, não especificada" },
  { code: "R42",    name: "Tontura",                                                  emr_id: "R42",   emr_label: "Tontura e instabilidade" },
  { code: "R06.0",  name: "Dispnéia",                                                 emr_id: "R060",  emr_label: "Dispnéia" },
  { code: "I10",    name: "Hipertensão",                                              emr_id: "I10",   emr_label: "Hipertensão essencial (primária)" },

  // ── Trauma / Lesões ──
  { code: "S09.9",  name: "Trauma na cabeça",                                         emr_id: "S099",  emr_label: "Traumatismo não especificado da cabeça" },
  { code: "T14.9",  name: "Trauma não especificado",                                  emr_id: "T149",  emr_label: "Traumatismo não especificado" },
  { code: "S93.4",  name: "Entorse de tornozelo",                                     emr_id: "S934",  emr_label: "Entorse e distensão do tornozelo" },

  // ── Urológico ──
  { code: "N30.0",  name: "Cistite aguda",                                            emr_id: "N300",  emr_label: "Cistite aguda" },

  // ── Psiquiátrico ──
  { code: "F41.1",  name: "Ansiedade generalizada",                                   emr_id: "F411",  emr_label: "Ansiedade generalizada" },
  { code: "F41.0",  name: "Transtorno de pânico",                                     emr_id: "F410",  emr_label: "Transtorno de pânico [ansiedade paroxística episódica]" },
  { code: "F32.8",  name: "Depressão",                                                emr_id: "F328",  emr_label: "Outros episódios depressivos" },
  { code: "F32.9",  name: "Episódio depressivo não especificado",                     emr_id: "F329",  emr_label: "Episódio depressivo não especificado" },
];

// Busca fuzzy por código, nome ou label EMR
window.TOCAFICHADR_cidSearch = function(query) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase().trim();
  return TOCAFICHADR_CID.filter(function(c) {
    return c.code.toLowerCase().includes(q) ||
           c.name.toLowerCase().includes(q) ||
           c.emr_label.toLowerCase().includes(q);
  }).slice(0, 8);
};

// Busca por código exato (com ou sem ponto)
window.TOCAFICHADR_cidByCode = function(code) {
  if (!code) return null;
  const normalized = code.trim();
  return TOCAFICHADR_CID.find(function(c) {
    return c.code === normalized || c.emr_id === normalized;
  }) || null;
};
