export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Поддержка CORS для VK Mini App
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
      // 1. Проверяем наличие ключей окружения
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return new Response(JSON.stringify({ 
          error: 'Missing environment variables: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' 
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // 2. POST ЗАПРОСЫ (Запись, удаление, Callback API ВК)
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));

        if (body.type === 'confirmation') {
          return new Response("eafd685b", { status: 200 });
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
          return new Response(JSON.stringify({ error: `Park with vk_group_id ${groupId} not found in database` }), { 
            status: 404, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
          });
        }

        return await handleAppAction(body, park);
      }

      // 3. GET ЗАПРОСЫ (Поиск участников, получение списка волонтеров)
      const groupId = url.searchParams.get('group_id');
      if (!groupId) {
        return new Response(JSON.stringify({ 
          status: 'online', 
          message: '5verst Multi-Tenant Core is running. Pass ?group_id=... to query a park.' 
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const park = await getParkConfigFromDB(env, groupId);
      if (!park) {
        return new Response(JSON.stringify({ error: `Park with vk_group_id ${groupId} not found in database` }), { 
          status: 404, 
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

/**
 * Прямой нативный REST запрос к Supabase без внешних npm-библиотек
 */
async function getParkConfigFromDB(env, groupId) {
  const endpoint = `${env.SUPABASE_URL}/rest/v1/parks?vk_group_id=eq.${groupId}&is_active=eq.true&select=*`;
  
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

/**
 * Авторизация в NRMS под учеткой парка
 */
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
    const data = await res.json();
    return data.result?.token || null;
  } catch (e) {
    return null;
  }
}

async function handleAppGet(url, park) {
  // Если запрашивают базовую инфу о парке (без дат и поиска)
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

  // Поиск участников через NRMS API
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
    const json = await res.json();
    return new Response(JSON.stringify(json), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Получение ростера на дату
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

  return new Response(JSON.stringify({ park_name: park.name, park_id: park.park_id }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

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

async function sendVkMessage(token, peerId, message) {
  try {
    await fetch(`https://api.vk.com/method/messages.send?peer_id=${peerId}&message=${encodeURIComponent(message)}&random_id=${Math.floor(Math.random() * 1000000)}&access_token=${token}&v=5.131`, {
      method: 'POST'
    });
  } catch (e) {}
}
