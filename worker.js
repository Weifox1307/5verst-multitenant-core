import parksConfig from './parks-config.json';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Поддержка CORS для запросов из VK Mini App
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
      // 1. POST ЗАПРОСЫ (Запись волонтера, удаление, подтверждение ВК)
      if (request.method === 'POST') {
        const body = await request.json();

        if (body.type === 'confirmation') {
          return new Response("eafd685b", { status: 200 });
        }

        const groupId = body.group_id || url.searchParams.get('group_id');
        const park = parksConfig[groupId];
        if (!park) return new Response(JSON.stringify({ error: 'Park not found' }), { status: 404 });

        return await handleAppAction(body, park);
      }

      // 2. GET ЗАПРОСЫ (Поиск участников через NRMS API, получение ростера)
      const groupId = url.searchParams.get('group_id');
      const park = parksConfig[groupId];
      if (!park) return new Response(JSON.stringify({ error: 'Park not found' }), { status: 404 });

      return await handleAppGet(url, park);

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};

async function getNrmsToken(user, pass) {
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
    const data = await res.json();
    return data.result?.token || null;
  } catch (e) {
    return null;
  }
}

async function handleAppGet(url, park) {
  const token = await getNrmsToken(park.nrms_user, park.nrms_pass);
  if (!token) {
    return new Response(JSON.stringify({ error: 'NRMS Auth failed' }), {
      status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Поиск участников (по ID с буквой А или по имени)
  if (url.searchParams.has('search')) {
    const query = url.searchParams.get('search')?.trim() || '';
    const cleanQuery = query.replace(/^A/i, '');
    const isId = /^\d+$/.test(cleanQuery);

    const endpoint = isId ? 'https://nrms.5verst.ru/api/v1/athlete/getListByIdPart' : 'https://nrms.5verst.ru/api/v1/athlete/getListByNamePart';
    const payload = isId ? { id: Number(cleanQuery) } : { name: query.toUpperCase(), event_id: park.park_id, registered_only: false };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    return new Response(JSON.stringify(json), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Получение списка записанных волонтеров на дату
  if (url.searchParams.has('date')) {
    const date = url.searchParams.get('date');
    const res = await fetch('https://nrms.5verst.ru/api/v1/event/volunteer/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ event_id: park.park_id, event_date: date })
    });
    const json = await res.json();
    return new Response(JSON.stringify(json.result?.volunteer_list || []), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response(JSON.stringify({ name: park.name, park_id: park.park_id }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function handleAppAction(body, park) {
  const token = await getNrmsToken(park.nrms_user, park.nrms_pass);
  if (!token) {
    return new Response(JSON.stringify({ error: 'NRMS Auth failed' }), {
      status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  if (body.roles && Array.isArray(body.roles)) {
    const verstIdNum = Number(body.verst_id.toString().replace(/^A/i, ''));
    
    await fetch('https://nrms.5verst.ru/api/v1/volunteer/event/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        event_id: park.park_id,
        date: body.target_date,
        event_date: body.target_date,
        upload_status_id: 1,
        volunteers: body.roles.map(r => ({ verst_id: verstIdNum, role_id: Number(r.id) }))
      })
    });

    if (!(body.silent === true || body.silent === "true")) {
      const roleNames = body.roles.map(r => r.name).join(', ');
      const msg = `⚡️ Новая запись в парке ${park.name}:\n${body.full_name} — ${roleNames} 🧡`;
      
      if (park.chat_ids && park.chat_ids.length > 0) {
        for (const chatId of park.chat_ids) {
          await sendVkMessage(park.vk_token, chatId, msg);
        }
      }
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

async function sendVkMessage(token, peerId, message) {
  try {
    await fetch(`https://api.vk.com/method/messages.send?peer_id=${peerId}&message=${encodeURIComponent(message)}&random_id=${Math.floor(Math.random() * 1000000)}&access_token=${token}&v=5.131`, {
      method: 'POST'
    });
  } catch (e) {}
}
