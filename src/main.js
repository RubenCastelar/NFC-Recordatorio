import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { appConfig } from "./config.js";

const supabase =
  appConfig.supabaseUrl && appConfig.supabaseKey
    ? createClient(appConfig.supabaseUrl, appConfig.supabaseKey)
    : null;

const storageKey = "nfc-abuelos-medications";
const notificationKey = "nfc-abuelos-notification-map";

const defaultState = {
  medications: [],
  notificationPermission:
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  banner: "",
  bannerTone: "neutral",
  isFormOpen: false,
  selectedMedicationId: null,
  editingMedicationId: null,
  draftIntakeTimes: ["09:00"]
};

let state = structuredClone(defaultState);

function uid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function loadLocalMedications() {
  return parseJson(localStorage.getItem(storageKey), []);
}

function saveLocalMedications(medications) {
  localStorage.setItem(storageKey, JSON.stringify(medications));
}

function loadNotificationMap() {
  return parseJson(localStorage.getItem(notificationKey), {});
}

function saveNotificationMap(map) {
  localStorage.setItem(notificationKey, JSON.stringify(map));
}

function daysToMs(days) {
  return Number(days) * 24 * 60 * 60 * 1000;
}

function hoursToMs(hours) {
  return Number(hours) * 60 * 60 * 1000;
}

function minutesToMs(minutes) {
  return Number(minutes) * 60 * 1000;
}

function formatRelative(ms) {
  const totalMinutes = Math.round(Math.abs(ms) / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);

  return parts.join(" ");
}

function parseTimeList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .filter((entry) => /^\d{2}:\d{2}$/.test(entry));
  }

  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => /^\d{2}:\d{2}$/.test(entry));
}

function formatTimeList(times) {
  return parseTimeList(times).join(", ");
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function differenceInCalendarDays(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startA = startOfDay(a);
  const startB = startOfDay(b);
  return Math.round((startA.getTime() - startB.getTime()) / msPerDay);
}

function buildScheduledOccurrence(baseDate, timeString) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const occurrence = new Date(baseDate);
  occurrence.setHours(hours, minutes, 0, 0);
  return occurrence;
}

function getScheduleConfig(medication) {
  const intervalDays = Number(medication.interval_days ?? 1);
  const intakeTimes = parseTimeList(medication.intake_times);

  if (intakeTimes.length > 0 && Number.isFinite(intervalDays) && intervalDays > 0) {
    return {
      mode: "calendar",
      intervalDays,
      intakeTimes
    };
  }

  return {
    mode: "legacy",
    frequencyHours: Number(medication.frequency_hours ?? 24)
  };
}

function getNextScheduledDate(medication, referenceDate = new Date()) {
  const schedule = getScheduleConfig(medication);

  if (schedule.mode === "legacy") {
    const lastTaken = medication.last_taken_at
      ? new Date(medication.last_taken_at)
      : null;
    const frequencyMs = hoursToMs(schedule.frequencyHours);

    if (!lastTaken) {
      return new Date(referenceDate.getTime() + frequencyMs);
    }

    return new Date(lastTaken.getTime() + frequencyMs);
  }

  const anchor = medication.schedule_anchor_at
    ? new Date(medication.schedule_anchor_at)
    : medication.created_at
      ? new Date(medication.created_at)
      : new Date();

  const startDate = startOfDay(anchor);
  const daysSinceAnchor = Math.max(0, differenceInCalendarDays(referenceDate, startDate));
  const cycleOffset = daysSinceAnchor % schedule.intervalDays;
  let dayCursor = cycleOffset === 0 ? daysSinceAnchor : daysSinceAnchor + (schedule.intervalDays - cycleOffset);

  for (let cycle = 0; cycle < 370; cycle += 1) {
    const targetDate = new Date(startDate);
    targetDate.setDate(startDate.getDate() + dayCursor);

    for (const timeString of schedule.intakeTimes) {
      const occurrence = buildScheduledOccurrence(targetDate, timeString);
      if (occurrence.getTime() > referenceDate.getTime()) {
        return occurrence;
      }
    }

    dayCursor += schedule.intervalDays;
  }

  return new Date(referenceDate.getTime() + daysToMs(schedule.intervalDays));
}

function getPreviousScheduledDate(medication, referenceDate = new Date()) {
  const schedule = getScheduleConfig(medication);

  if (schedule.mode === "legacy") {
    const frequencyMs = hoursToMs(schedule.frequencyHours);
    return new Date(referenceDate.getTime() - frequencyMs);
  }

  const anchor = medication.schedule_anchor_at
    ? new Date(medication.schedule_anchor_at)
    : medication.created_at
      ? new Date(medication.created_at)
      : new Date();
  const startDate = startOfDay(anchor);
  const daysSinceAnchor = differenceInCalendarDays(referenceDate, startDate);

  for (let offset = Math.max(daysSinceAnchor, 0); offset >= 0; offset -= 1) {
    if (offset % schedule.intervalDays !== 0) continue;

    const targetDate = new Date(startDate);
    targetDate.setDate(startDate.getDate() + offset);
    const occurrences = schedule.intakeTimes
      .map((timeString) => buildScheduledOccurrence(targetDate, timeString))
      .filter((occurrence) => occurrence.getTime() < referenceDate.getTime())
      .sort((a, b) => a.getTime() - b.getTime());

    if (occurrences.length > 0) {
      return occurrences[occurrences.length - 1];
    }
  }

  return new Date(anchor);
}

function getMedicationStatus(medication, referenceDate = new Date()) {
  const baselineDate = medication.last_taken_at
    ? new Date(new Date(medication.last_taken_at).getTime() + 1000)
    : medication.schedule_anchor_at
      ? new Date(medication.schedule_anchor_at)
      : medication.created_at
        ? new Date(medication.created_at)
        : referenceDate;
  const dueDate = getNextScheduledDate(medication, baselineDate);
  const previousReference = getPreviousScheduledDate(medication, dueDate);
  const cycleDurationMs = Math.max(1, dueDate.getTime() - previousReference.getTime());
  const remainingMs = dueDate.getTime() - referenceDate.getTime();
  const elapsedMs = referenceDate.getTime() - previousReference.getTime();
  const ratioRemaining = Math.max(0, Math.min(1, 1 - elapsedMs / cycleDurationMs));

  return {
    ratioRemaining,
    overdue: remainingMs < 0,
    dueDate,
    remainingMs,
    scheduleLabel: getScheduleLabel(medication)
  };
}

function getScheduleLabel(medication) {
  const schedule = getScheduleConfig(medication);

  if (schedule.mode === "calendar") {
    const daysLabel = schedule.intervalDays === 1 ? "Cada día" : `Cada ${schedule.intervalDays} días`;
    return `${daysLabel} · ${schedule.intakeTimes.join(" · ")}`;
  }

  return `Cada ${schedule.frequencyHours} h`;
}

function getRingColor(status) {
  if (status.overdue) return "#c93a2f";
  if (status.ratioRemaining < 0.25) return "#ea8b1f";
  return "#1f8a70";
}

function getStatusLabel(status) {
  if (status.overdue) {
    return `Retraso ${formatRelative(status.remainingMs)}`;
  }

  return `Faltan ${formatRelative(status.remainingMs)}`;
}

function getSortedMedications(referenceDate = new Date()) {
  return [...state.medications].sort((a, b) => {
    const aStatus = getMedicationStatus(a, referenceDate);
    const bStatus = getMedicationStatus(b, referenceDate);
    return aStatus.remainingMs - bStatus.remainingMs;
  });
}

function getSelectedMedication() {
  if (!state.medications.length) return null;

  const sorted = getSortedMedications();
  const selected =
    state.selectedMedicationId &&
    state.medications.find(
      (medication) => medication.id === state.selectedMedicationId
    );

  return selected ?? sorted[0];
}

function syncSelectedMedication() {
  const selected = getSelectedMedication();
  state.selectedMedicationId = selected ? selected.id : null;
}

function getDraftIntakeTimes() {
  const validTimes = parseTimeList(state.draftIntakeTimes);
  return validTimes.length ? validTimes : ["09:00"];
}

function openMedicationForm(editingMedication = null) {
  state.isFormOpen = true;
  state.editingMedicationId = editingMedication?.id ?? null;
  state.draftIntakeTimes = editingMedication
    ? parseTimeList(editingMedication.intake_times)
    : ["09:00"];
}

function closeMedicationForm() {
  state.isFormOpen = false;
  state.editingMedicationId = null;
  state.draftIntakeTimes = ["09:00"];
}

async function fetchMedications() {
  if (!supabase) {
    state.medications = loadLocalMedications();
    syncSelectedMedication();
    return;
  }

  const { data, error } = await supabase
    .from("medications")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    state.banner = `No se pudo leer Supabase (${error.message}). Revisa tablas y politicas RLS. Se usa almacenamiento local.`;
    state.bannerTone = "warning";
    state.medications = loadLocalMedications();
    syncSelectedMedication();
    return;
  }

  state.medications = data ?? [];
  saveLocalMedications(state.medications);
  syncSelectedMedication();
}

async function createMedication(payload) {
  if (!supabase) {
    const medication = {
      id: uid(),
      created_at: nowIso(),
      ...payload
    };

    state.medications = [medication, ...state.medications];
    saveLocalMedications(state.medications);
    state.selectedMedicationId = medication.id;
    return medication;
  }

  const { data, error } = await supabase
    .from("medications")
    .insert(payload)
    .select()
    .single();

  if (error) {
    throw error;
  }

  state.medications = [data, ...state.medications];
  saveLocalMedications(state.medications);
  state.selectedMedicationId = data.id;
  return data;
}

async function updateMedication(medicationId, payload) {
  if (!supabase) {
    state.medications = state.medications.map((medication) =>
      medication.id === medicationId ? { ...medication, ...payload } : medication
    );
    saveLocalMedications(state.medications);
    return;
  }

  const { data, error } = await supabase
    .from("medications")
    .update(payload)
    .eq("id", medicationId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  state.medications = state.medications.map((medication) =>
    medication.id === medicationId ? data : medication
  );
  saveLocalMedications(state.medications);
}

async function markMedicationTaken(medicationId, silent = false) {
  const takenAt = nowIso();

  if (!supabase) {
    state.medications = state.medications.map((medication) =>
      medication.id === medicationId
        ? { ...medication, last_taken_at: takenAt }
        : medication
    );
    saveLocalMedications(state.medications);
  } else {
    const { data, error } = await supabase
      .from("medications")
      .update({ last_taken_at: takenAt })
      .eq("id", medicationId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    state.medications = state.medications.map((medication) =>
      medication.id === medicationId ? data : medication
    );
    saveLocalMedications(state.medications);

    await supabase.from("intake_logs").insert({
      medication_id: medicationId,
      taken_at: takenAt,
      source: "nfc"
    });
  }

  const notificationMap = loadNotificationMap();
  delete notificationMap[medicationId];
  saveNotificationMap(notificationMap);

  if (!silent) {
    state.banner = "Medicacion registrada correctamente.";
    state.bannerTone = "success";
  }
}

function buildNfcUrl(medicationId) {
  const url = new URL(window.location.href);
  url.searchParams.set("action", "take");
  url.searchParams.set("med", medicationId);
  return url.toString();
}

function notificationSummary() {
  if (state.notificationPermission === "granted") {
    return "Avisos activados";
  }
  if (state.notificationPermission === "denied") {
    return "Avisos bloqueados";
  }
  if (state.notificationPermission === "unsupported") {
    return "Este navegador no permite avisos";
  }
  return "Avisos pendientes de permiso";
}

function appShell() {
  const selectedMedication = getSelectedMedication();
  const medicationOptions = getSortedMedications()
    .map((medication) => medicationSelectorOption(medication))
    .join("");
  const editingMedication =
    state.editingMedicationId &&
    state.medications.find(
      (medication) => medication.id === state.editingMedicationId
    );
  const draftTimes = getDraftIntakeTimes();

  return `
    <main class="app-shell">
      ${
        state.banner
          ? `<div class="banner banner-${state.bannerTone}">${state.banner}</div>`
          : ""
      }

      <section class="minimal-stage">
        <header class="stage-header">
          <div>
            <p class="eyebrow">Medicación con NFC</p>
            <h1>La próxima toma, de un vistazo.</h1>
          </div>
          <button class="notify-button" data-action="enable-notifications">
            ${notificationSummary()}
          </button>
        </header>

        ${
          selectedMedication
            ? medicationCard(selectedMedication)
            : `<div class="empty-orb">
                <button
                  class="empty-orb-ring add-orb-button"
                  data-action="toggle-form"
                  aria-label="Añadir medicación"
                >
                  <span>+</span>
                </button>
                <h2>Añade tu primer medicamento</h2>
                <p>Toca el botón + para indicar qué tomar y cada cuánto tiempo.</p>
              </div>`
        }

        ${
          medicationOptions
            ? `<div class="medication-selector">${medicationOptions}</div>`
            : ""
        }
      </section>

      ${
        state.isFormOpen
          ? `<section class="modal-backdrop" data-action="close-form">
              <div class="modal-card" role="dialog" aria-modal="true">
                <div class="modal-header">
                  <h2>${editingMedication ? "Editar medicación" : "Nueva medicación"}</h2>
                  <button class="icon-button" data-action="close-form" aria-label="Cerrar">
                    ×
                  </button>
                </div>

                <form id="medication-form" class="medication-form">
                  <label>
                    <span>Medicamento</span>
                    <input
                      name="name"
                      type="text"
                      placeholder="Ej. Pastilla azul"
                      value="${editingMedication?.name ?? ""}"
                      required
                    />
                  </label>

                  <label>
                    <span>Cómo tomarlo</span>
                    <input
                      name="dosage"
                      type="text"
                      placeholder="Ej. 1 pastilla"
                      value="${editingMedication?.dosage ?? ""}"
                      required
                    />
                  </label>

                  <label>
                    <span>Cada cuántos días</span>
                    <input
                      name="interval_days"
                      type="number"
                      min="1"
                      step="1"
                      value="${editingMedication?.interval_days ?? 1}"
                      required
                    />
                  </label>

                  <label>
                    <span>A qué horas</span>
                    <div class="time-group">
                      ${draftTimes
                        .map(
                          (time, index) => `
                            <div class="time-row">
                              <input
                                name="intake_time_${index}"
                                type="time"
                                value="${time}"
                                required
                              />
                              ${
                                draftTimes.length > 1
                                  ? `<button
                                      type="button"
                                      class="time-remove-button"
                                      data-action="remove-time"
                                      data-index="${index}"
                                      aria-label="Eliminar hora"
                                    >
                                      −
                                    </button>`
                                  : ""
                              }
                            </div>
                          `
                        )
                        .join("")}
                      <button type="button" class="time-add-button" data-action="add-time">
                        + Añadir hora
                      </button>
                    </div>
                  </label>

                  <label>
                    <span>Recordatorio tras exceder el tiempo (minutos)</span>
                    <input
                      name="reminder_minutes"
                      type="number"
                      min="5"
                      step="5"
                      value="${editingMedication?.reminder_minutes ?? 30}"
                      required
                    />
                  </label>

                  <button type="submit" class="primary-button">
                    ${editingMedication ? "Guardar cambios" : "Guardar"}
                  </button>
                </form>
              </div>
            </section>`
          : ""
      }
    </main>
  `;
}

function medicationSelectorOption(medication) {
  const isActive = medication.id === state.selectedMedicationId;
  return `
    <button
      class="medication-chip ${isActive ? "is-active" : ""}"
      data-action="select-medication"
      data-id="${medication.id}"
    >
      ${medication.name}
    </button>
  `;
}

function formatTimeDisplay(status) {
  if (status.overdue) {
    return `+${formatRelative(status.remainingMs)}`;
  }

  return formatRelative(status.remainingMs);
}

function medicationCard(medication) {
  const status = getMedicationStatus(medication);
  const progress = Math.round(status.ratioRemaining * 100);
  const ringColor = getRingColor(status);
  const nfcUrl = buildNfcUrl(medication.id);

  return `
    <article class="focus-card">
      <div
        class="hero-orb"
        style="--progress:${progress}%; --ring-color:${ringColor}; --progress-deg:${Math.max(
          0,
          Math.min(360, Math.round(status.ratioRemaining * 360))
        )}deg;"
        aria-label="${getStatusLabel(status)}"
      >
        <div class="hero-orb-inner">
          <span class="orb-label">${status.overdue ? "Fuera de hora" : "Tiempo restante"}</span>
          <strong>${formatTimeDisplay(status)}</strong>
          <span class="orb-subtitle">${status.scheduleLabel}</span>
        </div>
      </div>

      <div class="focus-copy">
        <h2>${medication.name}</h2>
        <p>${medication.dosage}</p>
      </div>

      <div class="focus-actions">
        <button class="primary-button" data-action="take" data-id="${medication.id}">
          Me lo he tomado
        </button>
        <button class="secondary-button" data-action="edit" data-id="${medication.id}">
          Editar medicación
        </button>
        <button class="secondary-button" data-action="copy-nfc" data-url="${nfcUrl}">
          Copiar enlace NFC
        </button>
      </div>
    </article>
  `;
}

function render() {
  const app = document.querySelector("#app");
  app.innerHTML = appShell();

  const form = document.querySelector("#medication-form");
  if (form) {
    form.addEventListener("submit", handleCreateMedication);
  }

  document.querySelectorAll("[data-action='take']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const medicationId = event.currentTarget.dataset.id;

      try {
        await markMedicationTaken(medicationId);
      } catch {
        state.banner = "No se pudo registrar la toma.";
        state.bannerTone = "danger";
      }

      render();
    });
  });

  document.querySelectorAll("[data-action='copy-nfc']").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const url = event.currentTarget.dataset.url;
      await navigator.clipboard.writeText(url);
      state.banner = "Enlace copiado. Ese es el que debes grabar en la etiqueta NFC.";
      state.bannerTone = "success";
      render();
    });
  });

  document.querySelectorAll("[data-action='toggle-form']").forEach((button) => {
    button.addEventListener("click", () => {
      openMedicationForm();
      render();
    });
  });

  const modalBackdrop = document.querySelector(".modal-backdrop");
  if (modalBackdrop) {
    modalBackdrop.addEventListener("click", (event) => {
      if (event.target !== event.currentTarget) return;
      closeMedicationForm();
      render();
    });
  }

  document.querySelectorAll(".icon-button[data-action='close-form']").forEach((button) => {
    button.addEventListener("click", () => {
      closeMedicationForm();
      render();
    });
  });

  document.querySelectorAll("[data-action='edit']").forEach((button) => {
    button.addEventListener("click", (event) => {
      const medication = state.medications.find(
        (entry) => entry.id === event.currentTarget.dataset.id
      );
      openMedicationForm(medication);
      render();
    });
  });

  document.querySelectorAll("[data-action='add-time']").forEach((button) => {
    button.addEventListener("click", () => {
      state.draftIntakeTimes = [...getDraftIntakeTimes(), "09:00"];
      render();
    });
  });

  document.querySelectorAll("[data-action='remove-time']").forEach((button) => {
    button.addEventListener("click", (event) => {
      const index = Number(event.currentTarget.dataset.index);
      state.draftIntakeTimes = getDraftIntakeTimes().filter((_, i) => i !== index);
      render();
    });
  });

  document.querySelectorAll(".time-row input[type='time']").forEach((input, index) => {
    input.addEventListener("input", (event) => {
      const nextTimes = [...getDraftIntakeTimes()];
      nextTimes[index] = event.currentTarget.value;
      state.draftIntakeTimes = nextTimes;
    });
  });

  document.querySelectorAll("[data-action='select-medication']").forEach((button) => {
    button.addEventListener("click", (event) => {
      state.selectedMedicationId = event.currentTarget.dataset.id;
      render();
    });
  });

  const notifyButton = document.querySelector("[data-action='enable-notifications']");
  if (notifyButton) {
    notifyButton.addEventListener("click", enableNotifications);
  }
}

async function handleCreateMedication(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);

  const payload = {
    name: String(formData.get("name")).trim(),
    dosage: String(formData.get("dosage")).trim(),
    interval_days: Number(formData.get("interval_days")),
    intake_times: getDraftIntakeTimes(),
    frequency_hours: Number(formData.get("interval_days")) * 24,
    reminder_minutes: Number(formData.get("reminder_minutes")),
    schedule_anchor_at:
      (state.editingMedicationId &&
        state.medications.find(
          (medication) => medication.id === state.editingMedicationId
        )?.schedule_anchor_at) ||
      nowIso()
  };

  try {
    if (state.editingMedicationId) {
      await updateMedication(state.editingMedicationId, payload);
      state.banner = "Medicacion actualizada.";
    } else {
      payload.last_taken_at = null;
      await createMedication(payload);
      state.banner = "Medicacion guardada.";
    }
    state.bannerTone = "success";
    form.reset();
    closeMedicationForm();
  } catch (error) {
    state.banner = `No se pudo guardar en Supabase (${error.message}).`;
    state.bannerTone = "danger";
  }

  render();
}

async function enableNotifications() {
  if (typeof Notification === "undefined") {
    state.notificationPermission = "unsupported";
    render();
    return;
  }

  const permission = await Notification.requestPermission();
  state.notificationPermission = permission;

  state.banner =
    permission === "granted"
      ? "Avisos activados."
      : "No se activaron los avisos.";
  state.bannerTone = permission === "granted" ? "success" : "warning";
  render();
}

async function handleNfcActionFromUrl() {
  const url = new URL(window.location.href);
  const action = url.searchParams.get("action");
  const medicationId = url.searchParams.get("med");

  if (action !== "take" || !medicationId) return;

  try {
    await markMedicationTaken(medicationId, true);
    state.banner = "Toma registrada desde el NFC.";
    state.bannerTone = "success";
  } catch {
    state.banner = "El NFC se ha leído, pero no se pudo registrar la toma.";
    state.bannerTone = "danger";
  }

  url.searchParams.delete("action");
  url.searchParams.delete("med");
  window.history.replaceState({}, "", url);
}

function maybeSendNotifications() {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }

  const notificationMap = loadNotificationMap();
  const currentTime = Date.now();

  state.medications.forEach((medication) => {
    const status = getMedicationStatus(medication, new Date(currentTime));
    if (!status.overdue) return;

    const lastNotificationAt = notificationMap[medication.id]
      ? new Date(notificationMap[medication.id]).getTime()
      : 0;
    const threshold = minutesToMs(medication.reminder_minutes);

    if (currentTime - lastNotificationAt < threshold) return;

    new Notification(`Recuerda tu medicacion: ${medication.name}`, {
      body: `Toca ${medication.dosage}. Ya vas ${formatRelative(status.remainingMs)} tarde.`
    });

    notificationMap[medication.id] = new Date(currentTime).toISOString();
  });

  saveNotificationMap(notificationMap);
}

async function init() {
  await fetchMedications();
  await handleNfcActionFromUrl();
  render();
  maybeSendNotifications();

  setInterval(() => {
    render();
    maybeSendNotifications();
  }, 60000);
}

init();
