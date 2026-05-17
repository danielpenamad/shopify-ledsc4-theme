// Backoffice page — orchestrates calls to the 4 Supabase edge functions.
//
// Reads HMAC + customer ID + base URL from data-attributes on
// [data-bo-root] (rendered by sections/admin-backoffice-resumen.liquid).
// On load, calls list-pending-customers and populates KPIs, whitelist
// list, and pending table. Wires up actions (approve, reject, update
// whitelist) and refetches on success.
//
// Auth model: HMAC firmado en Liquid SSR es el único secret que viaja al
// cliente (TTL 600s). Cada edge function vuelve a verificar el tag
// 'backoffice' del approver server-side. Si el HMAC expira, recargar la
// página obtiene un timestamp nuevo.

(function () {
  'use strict';

  const root = document.querySelector('[data-bo-root]');
  if (!root) return;

  const CUSTOMER_ID = root.dataset.boCustomerId;
  const TIMESTAMP = Number(root.dataset.boTimestamp);
  const SIGNATURE = root.dataset.boSignature;
  const BASE = root.dataset.boBase || '';

  if (!CUSTOMER_ID || !TIMESTAMP || !SIGNATURE || !BASE) {
    setStatus('Configuración de backoffice incompleta. Recarga la página.', 'error');
    return;
  }

  const ENDPOINTS = {
    list: BASE + 'list-pending-customers',
    update: BASE + 'update-whitelist',
    approve: BASE + 'approve-customer',
    reject: BASE + 'reject-customer',
  };

  // ---------- helpers ----------

  function setStatus(msg, level) {
    const el = document.getElementById('bo-status');
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.level = level || '';
  }

  function setFeedback(targetId, msg, level) {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.level = level || '';
  }

  function authBody(extra) {
    return Object.assign(
      { customerId: CUSTOMER_ID, timestamp: TIMESTAMP, signature: SIGNATURE },
      extra || {},
    );
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = { error: 'invalid_json_response', code: 'NETWORK_ERROR' };
    }
    return { status: res.status, ok: res.ok, data };
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return 'nunca';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function humanError(data, fallback) {
    if (!data) return fallback;
    if (data.code === 'SIGNATURE_EXPIRED') return 'La sesión ha expirado (10 min). Recarga la página.';
    if (data.code === 'NOT_BACKOFFICE') return 'No tienes permiso de backoffice.';
    if (data.code === 'INVALID_STATE') return 'El customer ya no está en estado "pendiente". Refresca la lista.';
    if (data.code === 'TARGET_NOT_FOUND') return 'Customer no encontrado.';
    return data.error || fallback;
  }

  // ---------- KPI / whitelist UI ----------

  function paintKpis(counts, lastUpdate) {
    const m = {
      pendiente: counts.pendiente, aprobado: counts.aprobado,
      rechazado: counts.rechazado, whitelist: counts.whitelist,
    };
    document.querySelectorAll('[data-bo-kpi]').forEach((el) => {
      const key = el.getAttribute('data-bo-kpi');
      if (key === 'whitelist_last_update') {
        el.textContent = fmtDateTime(lastUpdate);
      } else if (key in m) {
        el.textContent = String(m[key]);
      }
    });
  }

  function paintWhitelist(emails) {
    const list = document.getElementById('bo-whitelist-list');
    if (!list) return;
    list.innerHTML = '';
    if (!emails || emails.length === 0) {
      list.innerHTML = '<li class="bo__whitelist-empty">Vacía.</li>';
      return;
    }
    const sorted = emails.slice().sort();
    for (const e of sorted) {
      const li = document.createElement('li');
      li.className = 'bo__whitelist-item';

      const span = document.createElement('span');
      span.className = 'bo__whitelist-email';
      span.textContent = e;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bo__btn bo__btn--remove';
      btn.textContent = 'Quitar';
      btn.dataset.boRemoveEmail = e;

      li.appendChild(span);
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function wireWhitelistRemove() {
    const list = document.getElementById('bo-whitelist-list');
    if (!list) return;
    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-bo-remove-email]');
      if (!btn) return;
      const email = btn.dataset.boRemoveEmail;
      if (!email) return;
      if (!confirm('¿Quitar ' + email + ' de la whitelist?')) return;
      btn.disabled = true;
      setFeedback('bo-whitelist-feedback', 'Quitando ' + email + '…');
      const { status, ok, data } = await postJson(
        ENDPOINTS.update,
        authBody({ emails: email, mode: 'remove' }),
      );
      if (!ok || data.error) {
        btn.disabled = false;
        setFeedback('bo-whitelist-feedback', humanError(data, 'Error (' + status + ')'), 'error');
        return;
      }
      if (data.not_found) {
        setFeedback('bo-whitelist-feedback', email + ' ya no estaba en la whitelist.', 'warning');
      } else {
        setFeedback('bo-whitelist-feedback', email + ' quitado de la whitelist.', 'success');
      }
      await reload();
    });
  }

  // ---------- Pendientes table ----------

  function paintPendientes(pending, truncated) {
    const loading = document.getElementById('bo-pendientes-loading');
    const empty = document.getElementById('bo-pendientes-empty');
    const wrap = document.getElementById('bo-pendientes-table-wrap');
    const truncEl = document.getElementById('bo-pendientes-truncated');
    const tbody = document.querySelector('[data-bo-pendientes-rows]');

    if (loading) loading.hidden = true;
    if (truncEl) truncEl.hidden = !truncated;

    if (!pending || pending.length === 0) {
      if (wrap) wrap.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }

    if (empty) empty.hidden = true;
    if (wrap) wrap.hidden = false;
    if (!tbody) return;

    tbody.innerHTML = '';
    for (const c of pending) {
      const tr = document.createElement('tr');
      tr.dataset.boTargetId = c.id;
      tr.dataset.boTargetEmail = c.email || '';
      tr.innerHTML =
        '<td class="bo__cell-email">' + escapeHtml(c.email || '—') + '</td>' +
        '<td>' + escapeHtml(c.empresa || '—') + '</td>' +
        '<td>' + escapeHtml(c.nif || '—') + '</td>' +
        '<td>' + escapeHtml(c.sector || '—') + '</td>' +
        '<td>' + fmtDate(c.fechaRegistro) + '</td>' +
        '<td class="bo__pendientes-actions">' +
          '<button type="button" class="bo__btn bo__btn--primary" data-bo-action="approve">Aprobar</button>' +
          '<button type="button" class="bo__btn bo__btn--danger" data-bo-action="reject">Rechazar</button>' +
        '</td>';
      tbody.appendChild(tr);
    }
  }

  // ---------- Data load ----------

  async function reload() {
    setStatus('Actualizando…');
    const { status, ok, data } = await postJson(ENDPOINTS.list, authBody());
    if (!ok || data.error) {
      setStatus(humanError(data, 'Error al cargar (' + status + ')'), 'error');
      return null;
    }
    paintKpis(data.counts, data.whitelist?.lastUpdate);
    paintWhitelist(data.whitelist?.emails || []);
    paintPendientes(data.pending || [], !!data.pendingTruncated);
    setStatus('');
    return data;
  }

  // ---------- Whitelist form ----------

  function wireWhitelistForm() {
    const form = document.getElementById('bo-whitelist-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const textarea = document.getElementById('bo-whitelist-textarea');
      const submit = document.getElementById('bo-whitelist-submit');
      const emails = (textarea?.value || '').trim();
      if (!emails) {
        setFeedback('bo-whitelist-feedback', 'Pega al menos un email.', 'error');
        return;
      }
      submit.disabled = true;
      setFeedback('bo-whitelist-feedback', 'Procesando…');
      const { status, ok, data } = await postJson(
        ENDPOINTS.update,
        authBody({ emails }),
      );
      submit.disabled = false;
      if (!ok || data.error) {
        setFeedback('bo-whitelist-feedback', humanError(data, 'Error (' + status + ')'), 'error');
        return;
      }
      const stats =
        data.added + ' añadidos · ' +
        data.ignored_duplicates + ' duplicados · ' +
        (data.invalid?.length || 0) + ' inválidos · total: ' + data.total_now;
      const headline = data.promote_triggered
        ? 'Whitelist actualizada. Comprobando si hay solicitudes pendientes que coincidan…'
        : 'Whitelist actualizada (sin cambios nuevos). Las solicitudes pendientes se comprueban automáticamente cada cierto tiempo.';
      setFeedback('bo-whitelist-feedback', headline + ' (' + stats + ')', 'success');
      if (data.added > 0) textarea.value = '';
      if (data.invalid?.length) {
        setFeedback('bo-whitelist-feedback',
          headline + ' (' + stats + ' · inválidos: ' + data.invalid.join(', ') + ')',
          'warning');
      }
      // Refrescar siempre — counts y whitelist cambian.
      await reload();
    });
  }

  // ---------- Pendientes actions ----------

  let pendingRejectTarget = null;

  function wirePendientesActions() {
    const tbody = document.querySelector('[data-bo-pendientes-rows]');
    if (!tbody) return;
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-bo-action]');
      if (!btn) return;
      const tr = btn.closest('tr');
      if (!tr) return;
      const targetId = tr.dataset.boTargetId;
      const targetEmail = tr.dataset.boTargetEmail;
      const action = btn.getAttribute('data-bo-action');
      if (action === 'approve') {
        if (!confirm('¿Aprobar a ' + targetEmail + '? Se le creará el perfil B2B y recibirá un email de bienvenida.')) return;
        await runApprove(targetId, targetEmail, btn);
      } else if (action === 'reject') {
        openRejectDialog(targetId, targetEmail);
      }
    });

    const dialog = document.getElementById('bo-reject-dialog');
    const cancelBtn = document.getElementById('bo-reject-cancel');
    const form = document.getElementById('bo-reject-form');
    if (cancelBtn) cancelBtn.addEventListener('click', () => dialog?.close('cancel'));
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const motivo = (document.getElementById('bo-reject-motivo')?.value || '').trim();
      const target = pendingRejectTarget;
      pendingRejectTarget = null;
      if (dialog) dialog.close('confirm');
      if (!target) return;
      await runReject(target.id, target.email, motivo);
    });
  }

  function openRejectDialog(targetId, targetEmail) {
    pendingRejectTarget = { id: targetId, email: targetEmail };
    const dialog = document.getElementById('bo-reject-dialog');
    const targetEl = document.getElementById('bo-reject-target');
    const motivo = document.getElementById('bo-reject-motivo');
    if (targetEl) targetEl.textContent = targetEmail;
    if (motivo) motivo.value = '';
    if (dialog?.showModal) {
      dialog.showModal();
    } else {
      // Fallback: prompt nativo si <dialog> no soportado
      const m = window.prompt('Motivo del rechazo (opcional) para ' + targetEmail);
      if (m === null) return;
      runReject(targetId, targetEmail, m.trim());
    }
  }

  async function runApprove(targetId, targetEmail, btn) {
    btn.disabled = true;
    setStatus('Aprobando ' + targetEmail + '…');
    const { status, ok, data } = await postJson(
      ENDPOINTS.approve,
      authBody({ targetCustomerId: targetId }),
    );
    if (!ok || data.error) {
      btn.disabled = false;
      setStatus(humanError(data, 'Error al aprobar (' + status + ')'), 'error');
      return;
    }
    setStatus('Solicitud aprobada para ' + targetEmail + '.', 'success');
    await reload();
  }

  async function runReject(targetId, targetEmail, motivo) {
    setStatus('Rechazando ' + targetEmail + '…');
    const { status, ok, data } = await postJson(
      ENDPOINTS.reject,
      authBody({ targetCustomerId: targetId, motivo: motivo || '' }),
    );
    if (!ok || data.error) {
      setStatus(humanError(data, 'Error al rechazar (' + status + ')'), 'error');
      return;
    }
    setStatus('Solicitud rechazada para ' + targetEmail + '.', 'success');
    await reload();
  }

  // ---------- Init ----------

  function init() {
    wireWhitelistForm();
    wireWhitelistRemove();
    wirePendientesActions();
    reload();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
