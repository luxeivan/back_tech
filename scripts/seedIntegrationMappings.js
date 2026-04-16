#!/usr/bin/env node
require("dotenv").config();

const axios = require("axios");
const { getJwt } = require("../services/modus/strapi");

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const getArg = (name, fallback = "") => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] || fallback;
};

const APPLY = hasFlag("--apply");
const DRY_RUN = !APPLY;
const STRAPI_URL = String(process.env.URL_STRAPI || process.env.STRAPI_URL || "").replace(/\/$/, "");
const JWT_OVERRIDE = String(getArg("--jwt", getArg("--token", ""))).trim();
const API_TOKEN = String(
  process.env.STRAPI_API_TOKEN || process.env.STRAPI_INTEGRATION_MAPPINGS_TOKEN || ""
).trim();

if (!STRAPI_URL) {
  console.error("[MAP-SEED] Не задан URL_STRAPI (или STRAPI_URL) в .env");
  process.exit(1);
}

const http = axios.create({
  baseURL: STRAPI_URL,
  timeout: 30000,
});

function normalize(v) {
  return String(v == null ? "" : v)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function ruleKey(r) {
  return [
    normalize(r.integration),
    normalize(r.mappingType),
    normalize(r.sourceField),
    normalize(r.matchType),
    normalize(r.sourceValue),
  ].join("|");
}

function toRulePayload(r) {
  return {
    title: r.title,
    integration: r.integration,
    mappingType: r.mappingType,
    sourceField: r.sourceField,
    sourceValue: r.sourceValue,
    matchType: r.matchType,
    targetValue: r.targetValue,
    priority: r.priority,
    isActive: r.isActive,
    comment: r.comment || "",
  };
}

function toNormalizedItem(item) {
  const src = item?.attributes || item || {};
  return {
    id: item?.id || src?.id || null,
    documentId: item?.documentId || src?.documentId || null,
    title: src?.title || "",
    integration: src?.integration || "",
    mappingType: src?.mappingType || "",
    sourceField: src?.sourceField || "",
    sourceValue: src?.sourceValue || "",
    matchType: src?.matchType || "exact",
    targetValue: src?.targetValue || "",
    priority: Number(src?.priority || 100),
    isActive: src?.isActive !== false,
    comment: src?.comment || "",
  };
}

async function fetchAllExisting(token) {
  const out = [];
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount) {
    const r = await http.get("/api/integration-mappings", {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        "filters[integration][$eq]": "edds_new",
        "pagination[page]": page,
        "pagination[pageSize]": 200,
        "sort[0]": "priority:asc",
        "sort[1]": "id:asc",
      },
    });

    const rows = Array.isArray(r?.data?.data) ? r.data.data : [];
    rows.forEach((it) => out.push(toNormalizedItem(it)));
    pageCount = Number(r?.data?.meta?.pagination?.pageCount || 1);
    page += 1;
  }

  return out;
}

function buildDistrictRules() {
  const districts = [
    ["балашиха", "213a1aca-5c9e-4b94-a4e0-c5333882cba0"],
    ["богородский", "d1954143-4569-4938-b06a-2c51d07b8fe3"],
    ["бронницы", "292ca80f-50ec-4160-b7c8-adeb53774645"],
    ["власиха", "bc6c3bd3-95b9-4258-9726-089a9d207f13"],
    ["волоколамский", "5a5f9a40-b6a3-4ad8-af28-aff545e17b84"],
    ["воскресенск", "28ae170a-f54c-4ec4-8fcc-920f20871ea3"],
    ["восход", "93c36278-3ece-468d-a74f-5a77f8a1b863"],
    ["дзержинский", "646f3a1d-1087-454a-a412-c7c9831d67d0"],
    ["дмитровский", "07044206-f77f-4bbf-83b9-ce4f0432eaea"],
    ["долгопрудный", "79ba1e00-2b3f-466d-88db-50deeb27c4c9"],
    ["домодедово", "af2085e0-ca38-4a98-9bec-e43b7057ba6c"],
    ["дубна", "819d73c8-9375-4e39-8853-ddf003b42217"],
    ["егорьевск", "d8737d58-293f-4d6b-9d37-b1d588c04eaa"],
    ["жуковский", "f205bd3d-c738-4743-be7e-4a21084cb22f"],
    ["зарайск", "2d5657bb-0069-492f-bf7e-f521b14cddb1"],
    ["звездный", "4613a114-016a-4b72-9a9c-57a6961e1971"],
    ["истра", "42d90380-b3b2-42d3-bae2-3d3652a2e50d"],
    ["кашира", "3e5c43e5-95ec-4faf-9b4d-8612e6003a52"],
    ["клин", "d3757aca-5857-47ed-9566-5adc2b57afac"],
    ["коломна", "6e68c7e7-10ab-4965-aada-478aeae821db"],
    ["королев", "9d737e81-e677-43cb-83d2-4e11e5e5dc2c"],
    ["котельники", "5277759e-be05-4a2d-ba89-d8478add5a0c"],
    ["красногорск", "d55b49ba-475a-4141-b11f-9cb3f29e2205"],
    ["краснознаменск", "d34042a0-5440-40c5-8bc7-09383bd38cab"],
    ["ленинский", "c2c325fc-435f-4ab7-88fc-d632f6b33c87"],
    ["лобня", "36b29bf3-2a90-4c6c-9bc2-8dc59e890ef3"],
    ["лосино петровский", "9132b305-951c-423e-9bba-0b29d23fddd6"],
    ["лотошино", "b6515ab8-66eb-4f6d-8b9d-3667b287004d"],
    ["луховицы", "044de8a0-d790-49b3-a3e3-7ee7ea56e79c"],
    ["лыткарино", "462cc323-d81e-4564-9dc8-ee30f9a46b0a"],
    ["люберцы", "2e1b7a2a-55de-42be-aacf-6c625cad5ff5"],
    ["можайский", "d75a3e6e-3d43-4404-97d7-a0bb0ad01459"],
    ["молодежный", "f602fcc3-8b8b-4a03-b215-4aab8ca4e390"],
    ["москва", "0c5b2444-70a0-4932-980c-b4dc0d3f02b5"],
    ["мытищи", "aa29f2e6-5d7d-4e7b-b062-56c4fe0f39fe"],
    ["наро фоминский", "0d5fdd1b-a7fa-452e-bde7-6f752016d67b"],
    ["одинцовский", "b4d06790-77eb-44d8-8cfd-035404fb2fb7"],
    ["орехово зуевский", "57e6e3c2-486a-4265-afc6-af1c2d6729dc"],
    ["павлово посадский", "560e4d42-b5a8-4b34-9462-e8d4f048c964"],
    ["подольск", "26149e92-3a76-4bba-b332-1facc35f9311"],
    ["пушкинский", "113003b5-dae9-46de-99cf-28eb47763625"],
    ["раменский", "d77fcba7-6fd9-4e15-a70f-dba0e96a116e"],
    ["реутов", "98b2ade5-8a1b-4a98-b569-6aeefcb2ab8e"],
    ["рузский", "26580099-b45e-4834-b085-527485d692b7"],
    ["сергиево посадский", "ed7da874-3df1-4f99-a1f4-302a27be0d95"],
    ["серебряные пруды", "5f07f4b6-9b3b-45f2-937f-92a39ffd3128"],
    ["серпухов", "ef67af07-1d09-4924-a7e4-f2429428b581"],
    ["солнечногорск", "885695b8-1384-4c12-990e-1a2961a337b2"],
    ["ступино", "ec488b61-384c-48ff-a78d-117bc22c9674"],
    ["талдомский", "70ce2cc9-ded3-492a-9bda-a26dceb3bcd2"],
    ["фрязино", "a5845777-83fb-4cf0-bf14-6f24d900b389"],
    ["химки", "cd03d381-6681-4970-8d7a-f77b2bf108fa"],
    ["черноголовка", "d9b693fc-2211-424c-b570-d4a9f3c8d709"],
    ["чехов", "d000a228-e8ec-4e5f-8903-98a209c78d68"],
    ["шатура", "ef438532-11fe-459f-99b4-873b7f216125"],
    ["шаховская", "36087d43-b081-40fc-855c-8d65681d5cef"],
    ["щербинка", "89184dde-a93f-40ae-b6d5-8645833bddb3"],
    ["щелково", "277e8ad7-99a4-498a-8385-6f94c1dcac28"],
    ["электросталь", "b433362d-7f0c-48dd-91ae-2af6aed54879"],
  ];

  return districts.map(([name, fias]) => ({
    title: `ЕДДС district: ${name} -> ${fias}`,
    integration: "edds_new",
    mappingType: "district_fias",
    sourceField: "DISTRICT",
    sourceValue: name,
    matchType: "contains",
    targetValue: fias,
    priority: 10,
    isActive: true,
    comment: "FT-8",
  }));
}

function buildReasonRules() {
  const reasonPairs = [
    ["pole_break", "Излом опоры с обрывом/ без обрыва провода ВЛ"],
    ["vl_mech_damage", "Механическое повреждение ВЛ"],
    ["kl_mech_damage", "Механическое повреждение КЛ"],
    ["vl_break", "Обрыв провода ВЛ"],
    ["outage_0_4", "Отключение в сетях 0,4 кВ"],
    ["outage_cp", "Отключение с ЦП"],
    ["tree_fall_vl", "Падение дерева, постороннего предмета на ВЛ"],
    ["customer_network_damage", "Повреждение в абонентских сетях"],
    ["vl_damage", "Повреждение ВЛ"],
    ["vl_insulation_damage", "Повреждение изоляции ВЛ"],
    ["switchgear_damage_vl", "Повреждение коммутационного оборудования ВЛ"],
    ["tree_cutting_vl", "Вырубка древесно-кустарниковой растительности в охранной зоне ВЛ"],
    ["insulator_replacement_vl", "Замена изоляторов и арматуры на ВЛ"],
    ["cable_joint_replacement_kl", "Замена кабельной муфты на КЛ"],
    ["pole_wire_replacement_vl", "Замена опор, проводов, коммутационных аппаратов на ВЛ"],
    ["meter_replacement_ru", "Замена приборов учета в РУ"],
    ["switch_replacement_0_4_tp", "Замена рубильника 0,4 кВ, автоматического выключателя 0,4 кВ в ТП"],
    ["transformer_replacement_ps_rtp_tp", "Замена силового трансформатора на ПС, РТП, ТП"],
    ["kl_replacement", "Замена, перекладка КЛ"],
    ["wire_retensioning_vl", "Замена, перетяжка проводов ВЛ"],
    ["excavation_near_kl", "Земляные работы в охранной зоне КЛ"],
    ["vl_kl_overhaul", "Капитальный ремонт ВЛ, КЛ"],
    ["equipment_overhaul", "Капитальный ремонт электрооборудования ПС, РП, РТП, ТП"],
    ["safety_outage", "Отключение для безопасного проведения работ"],
    ["operational_switching", "Проведение оперативных переключений"],
    ["vl_kl_reconstruction", "Реконструкция ВЛ, КЛ"],
    ["equipment_maintenance", "Текущий ремонт электрооборудования ПС, РП, РТП, ТП"],
    ["connection_works", "Технологическое подключение потребителей"],
    ["tp_equipment_damage", "Повреждение оборудования ТП"],
    ["transformer_damage", "Повреждение силового трансформатора"],
    ["overload", "Превышение допустимой нагрузки"],
    ["kl_electrical_breakdown", "Электропробой КЛ"],
    ["vl_arrester_breakdown", "Электропробой разрядников ВЛ"],
  ];

  const out = [];
  for (const [code, text] of reasonPairs) {
    out.push({
      title: `ЕДДС reason code: ${code}`,
      integration: "edds_new",
      mappingType: "reason_code",
      sourceField: "BRIGADE_ACTION",
      sourceValue: code,
      matchType: "exact",
      targetValue: code,
      priority: 1,
      isActive: true,
      comment: "FT-9 code",
    });
    out.push({
      title: `ЕДДС reason text: ${text}`,
      integration: "edds_new",
      mappingType: "reason_code",
      sourceField: "BRIGADE_ACTION",
      sourceValue: text,
      matchType: "contains",
      targetValue: code,
      priority: 10,
      isActive: true,
      comment: "FT-9 description",
    });
  }

  return out;
}

function buildEquipmentRules() {
  const rows = [
    ["пс 110", "ps_110kv", 5],
    ["пс 100", "ps_110kv", 5],
    ["пс 35", "ps_35kv", 5],
    ["тп 0,4", "tp_0_4kv", 5],
    ["тп 0.4", "tp_0_4kv", 5],
    ["тп 6", "tp_6_20kv", 10],
    ["тп 10", "tp_6_20kv", 10],
    ["тп 20", "tp_6_20kv", 10],
    ["вл 110", "vl_110kv", 20],
    ["вл 35", "vl_35kv", 20],
    ["вл 0,4", "vl_0_4kv", 20],
    ["вл 0.4", "vl_0_4kv", 20],
    ["вл 6", "vl_6_20kv", 25],
    ["вл 10", "vl_6_20kv", 25],
    ["вл 20", "vl_6_20kv", 25],
    ["кл 100", "kl_100kv", 30],
    ["кл 110", "kl_100kv", 30],
    ["кл 35", "kl_35kv", 30],
    ["кл 0,4", "kl_0_4kv", 30],
    ["кл 0.4", "kl_0_4kv", 30],
    ["кл 6", "kl_6_20kv", 35],
    ["кл 10", "kl_6_20kv", 35],
    ["кл 20", "kl_6_20kv", 35],
    ["квл 110", "kvl_110kv", 40],
    ["квл 35", "kvl_35kv", 40],
    ["квл 0,4", "kvl_0_4kv", 40],
    ["квл 0.4", "kvl_0_4kv", 40],
    ["квл 6", "kvl_6_20kv", 45],
    ["квл 10", "kvl_6_20kv", 45],
    ["квл 20", "kvl_6_20kv", 45],
  ];

  return rows.map(([source, target, priority]) => ({
    title: `ЕДДС equipment: ${source} -> ${target}`,
    integration: "edds_new",
    mappingType: "equipment_type",
    // Используем допустимое значение enum sourceField из текущей схемы Strapi.
    // Для equipment_type фронт ориентируется на mappingType, а sourceField носит служебный характер.
    sourceField: "DISTRICT",
    sourceValue: source,
    matchType: "contains",
    targetValue: target,
    priority,
    isActive: true,
    comment: "Авто-маппинг типа оборудования для ЕДДС new",
  }));
}

function buildDesiredRules() {
  return [
    ...buildDistrictRules(),
    ...buildReasonRules(),
    ...buildEquipmentRules(),
  ];
}

function isSameMeaning(a, b) {
  return (
    normalize(a.title) === normalize(b.title) &&
    normalize(a.integration) === normalize(b.integration) &&
    normalize(a.mappingType) === normalize(b.mappingType) &&
    normalize(a.sourceField) === normalize(b.sourceField) &&
    normalize(a.sourceValue) === normalize(b.sourceValue) &&
    normalize(a.matchType) === normalize(b.matchType) &&
    normalize(a.targetValue) === normalize(b.targetValue) &&
    Number(a.priority || 100) === Number(b.priority || 100) &&
    Boolean(a.isActive) === Boolean(b.isActive) &&
    normalize(a.comment) === normalize(b.comment)
  );
}

async function createRule(token, payload) {
  return http.post(
    "/api/integration-mappings",
    { data: payload },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function updateRule(token, idOrDocId, payload) {
  return http.put(
    `/api/integration-mappings/${idOrDocId}`,
    { data: payload },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function main() {
  console.log("[MAP-SEED] Старт заполнения коллекции integration-mappings (edds_new)");
  console.log(`[MAP-SEED] Режим: ${DRY_RUN ? "dry-run (без записи)" : "apply (запись в Strapi)"}`);
  let token = "";
  if (JWT_OVERRIDE) {
    token = JWT_OVERRIDE;
    console.log("[MAP-SEED] Используем токен из аргумента --jwt/--token");
  } else if (API_TOKEN) {
    token = API_TOKEN;
    console.log("[MAP-SEED] Используем токен из STRAPI_API_TOKEN");
  } else {
    token = await getJwt();
    console.log("[MAP-SEED] Используем JWT сервисного пользователя (LOGIN_STRAPI)");
  }
  if (!token) {
    console.error("[MAP-SEED] Не удалось получить токен для Strapi");
    process.exit(1);
  }

  const desired = buildDesiredRules();
  const existing = await fetchAllExisting(token);

  const existingMap = new Map(existing.map((it) => [ruleKey(it), it]));

  const toCreate = [];
  const toUpdate = [];
  let unchanged = 0;

  for (const rule of desired) {
    const key = ruleKey(rule);
    const current = existingMap.get(key);
    if (!current) {
      toCreate.push(rule);
      continue;
    }

    if (isSameMeaning(current, rule)) {
      unchanged += 1;
      continue;
    }

    toUpdate.push({
      idOrDocId: current.documentId || current.id,
      rule,
      current,
    });
  }

  console.log(`[MAP-SEED] Всего желаемых правил: ${desired.length}`);
  console.log(`[MAP-SEED] Уже есть в Strapi (integration=edds_new): ${existing.length}`);
  console.log(`[MAP-SEED] К созданию: ${toCreate.length}`);
  console.log(`[MAP-SEED] К обновлению: ${toUpdate.length}`);
  console.log(`[MAP-SEED] Без изменений: ${unchanged}`);

  if (DRY_RUN) {
    if (toCreate.length) {
      console.log("\n[MAP-SEED] DRY-RUN: примеры на создание (первые 10):");
      toCreate.slice(0, 10).forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.mappingType} | ${r.sourceField} | ${r.sourceValue} -> ${r.targetValue}`);
      });
    }
    if (toUpdate.length) {
      console.log("\n[MAP-SEED] DRY-RUN: примеры на обновление (первые 10):");
      toUpdate.slice(0, 10).forEach((x, i) => {
        console.log(`  ${i + 1}. id=${x.idOrDocId} | ${x.rule.mappingType} | ${x.rule.sourceValue}`);
      });
    }
    console.log("\n[MAP-SEED] Dry-run завершён. Для записи запусти с флагом --apply");
    return;
  }

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const r of toCreate) {
    try {
      await createRule(token, toRulePayload(r));
      created += 1;
    } catch (e) {
      failed += 1;
      const msg = e?.response?.data?.error?.message || e?.response?.data?.error || e?.message;
      console.error(`[MAP-SEED] Ошибка создания ${r.mappingType}/${r.sourceValue}: ${msg}`);
    }
  }

  for (const x of toUpdate) {
    try {
      if (!x.idOrDocId) {
        failed += 1;
        console.error(`[MAP-SEED] Пропуск обновления (нет id/documentId): ${x.rule.sourceValue}`);
        continue;
      }
      await updateRule(token, x.idOrDocId, toRulePayload(x.rule));
      updated += 1;
    } catch (e) {
      failed += 1;
      const msg = e?.response?.data?.error?.message || e?.response?.data?.error || e?.message;
      console.error(`[MAP-SEED] Ошибка обновления id=${x.idOrDocId}: ${msg}`);
    }
  }

  console.log("\n[MAP-SEED] Готово");
  console.log(`[MAP-SEED] Создано: ${created}`);
  console.log(`[MAP-SEED] Обновлено: ${updated}`);
  console.log(`[MAP-SEED] Без изменений: ${unchanged}`);
  console.log(`[MAP-SEED] Ошибок: ${failed}`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  const status = e?.response?.status;
  if (status === 403) {
    console.error(
      "[MAP-SEED] 403 Forbidden: у токена нет прав на integration-mappings. " +
        "Передай --jwt <токен_с_правами> или настрой STRAPI_API_TOKEN."
    );
  }
  console.error("[MAP-SEED] Скрипт завершился с ошибкой:", e?.message || e);
  process.exit(1);
});
