export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return new Response(JSON.stringify({ 
          error: 'Missing environment variables: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' 
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // 1. POST ЗАПРОСЫ
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));

        if (body.type === 'confirmation') {
          return new Response("eafd685b", { status: 200 });
        }

        if (body.action === 'check_nrms') {
          return await handleCheckNrms(body);
        }

        if (body.action === 'register_park') {
          return await handleRegisterPark(env, body);
        }

        const groupId = body.group_id || url.searchParams.get('group_id');
        if (!groupId) {
          return new Response(JSON.stringify({ error: 'Missing group_id' }), { 
            status: 400, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
          });
        }

        const park = await getParkConfigFromDB(env, groupId);
        if (!park) {
          return new Response(JSON.stringify({ error: `Park not found`, not_configured: true }), { 
            status: 404, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
          });
        }

        if (body.action === 'delete') {
          return await handleDeleteAction(body, park);
        }

        return await handleAppAction(body, park);
      }

      // 2. GET ЗАПРОСЫ
      const groupId = url.searchParams.get('group_id');
      if (!groupId) {
        return new Response(JSON.stringify({ 
          status: 'online', 
          message: '5verst Multi-Tenant Core is running.' 
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const park = await getParkConfigFromDB(env, groupId);
      if (!park) {
        return new Response(JSON.stringify({ not_configured: true, group_id: Math.abs(Number(groupId)) }), { 
          status: 200, 
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
        });
      }

      return await handleAppGet(url, park);

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};

function formatNrmsDate(dateStr) {
  if (!dateStr) return '';
  if (dateStr.includes('.')) return dateStr;
  if (dateStr.includes('-')) {
    const parts = dateStr.split('-');
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  return dateStr;
}

function mapRoleForNrms(roleId) {
  const id = Number(roleId);
  if ([1001, 1002, 1003, 1007].includes(id)) return 8; // Чай, Вкусняшки, Вода, Диджей -> Подготовка
  if ([1004, 1005, 1006].includes(id)) return 10;     // Оратор, Поддержка, Оркестр -> Разное[cite: 4, 5]
  return id;
}

async function getParkConfigFromDB(env, groupId) {
  const cleanId = Math.abs(Number(groupId));
  const endpoint = `${env.SUPABASE_URL}/rest/v1/parks?vk_group_id=eq.${cleanId}&is_active=eq.true&select=*`;
  
  const response = await fetch(endpoint, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase REST error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data && data.length > 0 ? data[0] : null;
}

async function getNrmsToken(user, pass) {
  if (!user || !pass) return null;
  
  let cleanUser = user.trim();
  if (!cleanUser.toUpperCase().startsWith('A')) {
    cleanUser = 'A' + cleanUser;
  }

  try {
    const res = await fetch('https://nrms.5verst.ru/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cleanUser, password: pass })
    });
    const text = await res.text();
    const data = JSON.parse(text);
    return data.result?.token || null;
  } catch (e) {
    return null;
  }
}

async function handleCheckNrms(body) {
  const user = body.nrms_user;
  const pass = body.nrms_pass;

  if (!user || !pass) {
    return new Response(JSON.stringify({ success: false, error: 'Заполните логин и пароль' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const token = await getNrmsToken(user, pass);
  if (!token) {
    return new Response(JSON.stringify({ success: false, error: 'Неверный логин или пароль в NRMS' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  let parks = [];
  try {
    const profileRes = await fetch('https://nrms.5verst.ru/api/v1/user/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({})
    });
    const profileText = await profileRes.text();
    const profileData = JSON.parse(profileText);
    const eventList = profileData.result?.events || profileData.result?.event_list || [];

    if (Array.isArray(eventList) && eventList.length > 0) {
      parks = eventList.map(e => ({
        id: e.id || e.event_id,
        name: e.name || e.event_name || `Парк #${e.id}`
      }));
    }
  } catch (e) {}

  return new Response(JSON.stringify({ success: true, parks: parks }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function handleRegisterPark(env, body) {
  const { vk_group_id, park_id, park_name, nrms_user, nrms_pass, vk_access_token } = body;

  let cleanUser = nrms_user.trim();
  if (!cleanUser.toUpperCase().startsWith('A')) {
    cleanUser = 'A' + cleanUser;
  }

  const slug = `park-${park_id}`;
  const record = {
    park_id: Number(park_id),
    slug: slug,
    name: park_name || `5 вёрст #${park_id}`,
    vk_group_id: Math.abs(Number(vk_group_id)),
    vk_access_token: vk_access_token.trim(),
    chat_ids: ["2000000001"],
    nrms_user: cleanUser,
    nrms_pass_encrypted: nrms_pass.trim(),
    is_active: true
  };

  const endpoint = `${env.SUPABASE_URL}/rest/v1/parks`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(record)
  });

  return new Response(JSON.stringify({ success: res.ok }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function handleAppGet(url, park) {
  if (!url.searchParams.has('search') && !url.searchParams.has('date')) {
    return new Response(JSON.stringify({ 
      park_name: park.name, 
      park_id: park.park_id, 
      vk_group_id: park.vk_group_id 
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const token = await getNrmsToken(park.nrms_user, park.nrms_pass_encrypted);
  if (!token) {
    return new Response(JSON.stringify({ error: 'NRMS Authentication failed. Check credentials in database.' }), {
      status: 401, 
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
    });
  }

  if (url.searchParams.has('search')) {
    const query = url.searchParams.get('search')?.trim() || '';
    const cleanQuery = query.replace(/^A/i, '');
    const isId = /^\d+$/.test(cleanQuery);

    const endpoint = isId 
      ? 'https://nrms.5verst.ru/api/v1/athlete/getListByIdPart' 
      : 'https://nrms.5verst.ru/api/v1/athlete/getListByNamePart';
    const payload = isId 
      ? { id: Number(cleanQuery) } 
      : { name: query.toUpperCase(), event_id: park.park_id, registered_only: false };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch(e) { json = { result: { data: [] } }; }

    return new Response(JSON.stringify(json), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  if (url.searchParams.has('date')) {
    const rawDate = url.searchParams.get('date');
    const nrmsFormattedDate = formatNrmsDate(rawDate);

    const res = await fetch('https://nrms.5verst.ru/api/v1/event/volunteer/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ event_id: park.park_id, event_date: nrmsFormattedDate })
    });

    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (e) {}

    const rawList = json.result?.volunteer_list || [];
    const formattedList = rawList.map(v => ({
      verst_id: v.verst_id || v.id,
      full_name: v.full_name || v.name,
      role_id: v.role_id,
      role_name: v.role_name || 'Волонтёр',
      comment: v.comment || ''
    }));

    return new Response(JSON.stringify(formattedList), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response(JSON.stringify({ park_name: park.name, park_id: park.park_id }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

/**
 * ФОРМИРОВАНИЕ ПОЛНОГО КРАСИВОГО СПИСКА РОСТЕРА
 */
function buildRosterMessage(lastEntryHeader, allVolunteers, targetDate, parkGroupId) {
  const rosterTemplate = [
    { id: 1, label: "Организатор", count: 1 },
    { id: 35, label: "Разметка трассы", count: 1 },
    { id: 15, label: "Инструктаж новых участников", count: 1 },
    { id: 2, label: "Секундомер", count: 2 },
    { id: 13, label: "Карточки позиций", count: 1 },
    { id: 11, label: "Сканер", count: 1 },
    { id: 19, label: "Замыкающий", count: 1 },
    { id: 7, label: "Маршал", count: 3 },
    { id: 31, label: "Проведение разминки", count: 1 },
    { id: 8, label: "Подготовка мероприятия", count: 1 },
    { id: 1001, label: "Чай", count: 1 },
    { id: 1002, label: "Вкусняшки", count: 1 },
    { id: 1003, label: "Вода", count: 1 },
    { id: 1004, label: "Оратор", count: 1 },
    { id: 1005, label: "Поддержка на трассе", count: 1 },
    { id: 1006, label: "Человек Оркестр", count: 1 },
    { id: 1007, label: "Диджей", count: 1 },
    { id: 5, label: "Фотограф", count: 1 },
    { id: 38, label: "Видеограф", count: 1 }
  ];[cite: 4, 5]

  let msg = "";
  if (lastEntryHeader) {
    msg += `⚡️ ${lastEntryHeader}\n————————————————\n\n`;[cite: 4, 5]
  }

  msg += `📋 Список на ${targetDate}\n\n`;[cite: 4, 5]

  const usedVolunteers = new Set();

  rosterTemplate.forEach(item => {
    let slotsFound = 0;
    allVolunteers.forEach((v, idx) => {
      const vRoleId = Number(v.role_id);
      if (vRoleId === item.id && !usedVolunteers.has(idx)) {
        const comment = v.comment ? ` (${v.comment})` : "";[cite: 4, 5]
        msg += `⭐ ${item.label}${comment} — ${v.full_name}\n`;[cite: 4, 5]
        usedVolunteers.add(idx);
        slotsFound++;
      }
    });

    for (let j = slotsFound; j < item.count; j++) {
      msg += `➖ ${item.label} — \n`;[cite: 4, 5]
    }
  });

  let extra = "";
  allVolunteers.forEach((v, idx) => {
    if (!usedVolunteers.has(idx)) {
      const comment = v.comment ? ` (${v.comment})` : "";[cite: 4, 5]
      extra += `⭐ ${v.role_name || 'Волонтёр'}${comment} — ${v.full_name}\n`;[cite: 4, 5]
    }
  });

  if (extra) {
    msg += `\n➕ Дополнительно:\n${extra}`;[cite: 4, 5]
  }

  msg += `\n📝 Записаться: vk.ru/app54835513#-${parkGroupId}`;[cite: 4, 5]
  return msg;
}

/**
 * ЗАПИСЬ ВОЛОНТЕРА С ГЕНЕРАЦИЕЙ ПОЛНОГО РОСТЕРА В ЧАТ
 */
async function handleAppAction(body, park) {
  const token = await getNrmsToken(park.nrms_user, park.nrms_pass_encrypted);
  if (!token) {
    return new Response(JSON.stringify({ error: 'NRMS Authentication failed' }), {
      status: 401, 
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
    });
  }

  if (body.roles && Array.isArray(body.roles)) {
    const verstIdNum = Number(body.verst_id.toString().replace(/^A/i, ''));
    const nrmsFormattedDate = formatNrmsDate(body.target_date);

    // 1. Получаем текущий ростер
    let currentVolunteers = [];
    try {
      const getRes = await fetch('https://nrms.5verst.ru/api/v1/event/volunteer/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ event_id: park.park_id, event_date: nrmsFormattedDate })
      });
      const getData = await getRes.json();
      currentVolunteers = getData.result?.volunteer_list || [];
    } catch(e) {}

    // 2. Объединяем списки
    const fullVolunteersList = [];
    const volMap = new Map();

    currentVolunteers.forEach(v => {
      const vId = Number(v.verst_id || v.id);
      const rId = Number(v.role_id);
      if (vId && rId) {
        volMap.set(`${vId}_${mapRoleForNrms(rId)}`, { verst_id: vId, role_id: mapRoleForNrms(rId) });[cite: 4, 5]
        fullVolunteersList.push({
          verst_id: vId,
          role_id: rId,
          role_name: v.role_name || 'Волонтёр',
          full_name: v.full_name || v.name,
          comment: v.comment || ''
        });
      }
    });

    body.roles.forEach(r => {
      const mappedRole = mapRoleForNrms(r.id);
      volMap.set(`${verstIdNum}_${mappedRole}`, { verst_id: verstIdNum, role_id: mappedRole });
      fullVolunteersList.push({
        verst_id: verstIdNum,
        role_id: Number(r.id),
        role_name: r.name,
        full_name: body.full_name,
        comment: r.comment || ''
      });
    });

    // 3. Сохраняем в NRMS
    const savePayload = {
      event_id: park.park_id,
      date: nrmsFormattedDate,
      event_date: nrmsFormattedDate,
      upload_status_id: 1,
      volunteers: Array.from(volMap.values())
    };

    await fetch('https://nrms.5verst.ru/api/v1/volunteer/event/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(savePayload)
    });

    // 4. Отправляем полный ростер в чат ВК
    if (!(body.silent === true || body.silent === "true")) {
      const roleNames = body.roles.map(r => r.name).join(', ');
      const userMention = (body.target_vk_id && body.target_vk_id !== "0") 
        ? `[id${body.target_vk_id}|${body.full_name}]` 
        : body.full_name;

      const header = `Новая запись: ${userMention} — ${roleNames}`;[cite: 4, 5]
      const msg = buildRosterMessage(header, fullVolunteersList, nrmsFormattedDate, park.vk_group_id);

      const chatIds = Array.isArray(park.chat_ids) ? park.chat_ids : JSON.parse(park.chat_ids || '[]');
      for (const chatId of chatIds) {
        await sendVkMessage(park.vk_access_token, chatId, msg);
      }
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

/**
 * УДАЛЕНИЕ С ОТПРАВКОЙ ОБНОВЛЕННОГО РОСТЕРА В ЧАТ
 */
async function handleDeleteAction(body, park) {
  const token = await getNrmsToken(park.nrms_user, park.nrms_pass_encrypted);
  if (!token) {
    return new Response(JSON.stringify({ error: 'NRMS Authentication failed' }), {
      status: 401, 
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
    });
  }

  const verstIdNum = Number((body.verst_id || "0").toString().replace(/^A/i, ''));
  const roleIdNum = mapRoleForNrms(body.role_id);
  const nrmsFormattedDate = formatNrmsDate(body.target_date);

  let currentVolunteers = [];
  try {
    const getRes = await fetch('https://nrms.5verst.ru/api/v1/event/volunteer/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ event_id: park.park_id, event_date: nrmsFormattedDate })
    });
    const getData = await getRes.json();
    currentVolunteers = getData.result?.volunteer_list || [];
  } catch(e) {}

  const updatedVolunteers = [];
  const updatedDisplayList = [];

  currentVolunteers.forEach(v => {
    const vId = Number(v.verst_id || v.id);
    const rId = Number(v.role_id);
    if (!(vId === verstIdNum && mapRoleForNrms(rId) === roleIdNum)) {
      updatedVolunteers.push({ verst_id: vId, role_id: mapRoleForNrms(rId) });[cite: 4, 5]
      updatedDisplayList.push({
        verst_id: vId,
        role_id: rId,
        role_name: v.role_name || 'Волонтёр',
        full_name: v.full_name || v.name,
        comment: v.comment || ''
      });
    }
  });

  await fetch('https://nrms.5verst.ru/api/v1/volunteer/event/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      event_id: park.park_id,
      date: nrmsFormattedDate,
      event_date: nrmsFormattedDate,
      upload_status_id: 1,
      volunteers: updatedVolunteers
    })
  });

  const header = `❌ Отмена записи: ${body.person_name || 'Волонтёр'} снят(а) с позиции «${body.role_name || 'Волонтёр'}»`;[cite: 4, 5]
  const msg = buildRosterMessage(header, updatedDisplayList, nrmsFormattedDate, park.vk_group_id);

  const chatIds = Array.isArray(park.chat_ids) ? park.chat_ids : JSON.parse(park.chat_ids || '[]');
  for (const chatId of chatIds) {
    await sendVkMessage(park.vk_access_token, chatId, msg);
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function sendVkMessage(token, peerId, message) {
  if (!token || token === 'mock_token') return;
  try {
    await fetch(`https://api.vk.com/method/messages.send?peer_id=${peerId}&message=${encodeURIComponent(message)}&random_id=${Math.floor(Math.random() * 1000000)}&access_token=${token}&v=5.131`, {
      method: 'POST'
    });
  } catch (e) {}
}
