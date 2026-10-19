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

        // Подтверждение сервера Callback API ВКонтакте
        if (body.type === 'confirmation') {
          return new Response("eafd685b", { status: 200 });
        }

        // ШАГ 1 ОНБОРДИНГА: Проверка логина/пароля в NRMS и получение списка доступных парков
        if (body.action === 'check_nrms') {
          return await handleCheckNrms(body);
        }

        // ШАГ 2 ОНБОРДИНГА: Сохранение нового парка в Supabase
        if (body.action === 'register_park') {
          return await handleRegisterPark(env, body);
        }

        // Штатные действия для настроенного парка
        const groupId = body.group_id || url.searchParams.get('group_id');
        if (!groupId) {
          return new Response(JSON.stringify({ error: 'Missing group_id' }), { 
            status: 400, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
          });
        }

        const park = await getParkConfigFromDB(env, groupId);
        if (!park) {
          return new Response(JSON.stringify({ error: `Park with vk_group_id ${groupId} not configured`, not_configured: true }), { 
            status: 404, 
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
          });
        }

        return await handleAppAction(body, park);
      }

      // 2. GET ЗАПРОСЫ
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
        return new Response(JSON.stringify({ not_configured: true, group_id: Number(groupId) }), { 
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

/**
 * REST запрос к Supabase без npm пакетов с очисткой знака минус
 */
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

/**
 * Авторизация в NRMS под логином организатора (формат A...)
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

/**
 * Проверка учетки организатора и выдача списка всех закрепленных за ним парков
 */
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
    const profileData = await profileRes.json();
    const eventList = profileData.result?.events || profileData.result?.event_list || [];

    if (Array.isArray(eventList) && eventList.length > 0) {
      parks = eventList.map(e => ({
        id: e.id || e.event_id,
        name: e.name || e.event_name || `Парк #${e.id}`
      }));
    }
  } catch (e) {}

  if (parks.length === 0) {
    try {
      const allEventsRes = await fetch('https://nrms.5verst.ru/api/v1/event/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({})
      });
      const allData = await allEventsRes.json();
      if (allData.result?.events) {
        parks = allData.result.events.map(e => ({ id: e.id, name: e.name }));
      }
    } catch (e) {}
  }

  return new Response(JSON.stringify({ success: true, parks: parks }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

/**
 * Сохранение нового парка в Supabase
 */
async function handleRegisterPark(env, body) {
  const { vk_group_id, park_id, park_name, nrms_user, nrms_pass, vk_access_token } = body;

  if (!vk_group_id || !park_id || !nrms_user || !nrms_pass || !vk_access_token) {
    return new Response(JSON.stringify({ success: false, error: 'Заполнены не все поля' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const cleanGroupId = Math.abs(Number(vk_group_id));
    const vkTest = await fetch(`https://api.vk.com/method/groups.getById?group_id=${cleanGroupId}&access_token=${vk_access_token}&v=5.131`);
    const vkData = await vkTest.json();
    if (vkData.error) {
      return new Response(JSON.stringify({ success: false, error: 'Неверный токен группы ВК: ' + vkData.error.error_msg }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: 'Ошибка проверки токена ВК' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

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
    chat_ids: [],
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

  if (!res.ok) {
    return new Response(JSON.stringify({ success: false, error: 'Ошибка Supabase: ' + await res.text() }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response(JSON.stringify({ success: true }), {
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

  // Поиск участников
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

  // ПОЛУЧЕНИЕ РОСТЕРА ВОЛОНТЕРОВ НА ДАТУ (ИСПРАВЛЕНО ДЛЯ NRMS)
  if (url.searchParams.has('date')) {
    const date = url.searchParams.get('date');
    
    // Запрос 1: Основной маршрут получения волонтеров мероприятия
    let res = await fetch('https://nrms.5verst.ru/api/v1/volunteer/event/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ event_id: park.park_id, date: date, event_date: date })
    });
    let json = await res.json();

    // Запрос 2: Резервный маршрут, если первый вернул пустоту
    if (!json.result || (!json.result.volunteers && !json.result.volunteer_list)) {
      res = await fetch('https://nrms.5verst.ru/api/v1/event/volunteer/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ event_id: park.park_id, event_date: date })
      });
      json = await res.json();
    }

    const rawList = json.result?.volunteers || json.result?.volunteer_list || json.result?.data || [];
    
    // Нормализация под формат фронтенда
    const formattedList = rawList.map(v => ({
      verst_id: v.verst_id || v.athlete_id || v.id,
      full_name: v.full_name || v.athlete_name || v.name,
      role_id: v.role_id,
      role_name: v.role_name || v.name_ru || 'Волонтёр',
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
