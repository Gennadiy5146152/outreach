function errorText(field) {
  if (!field.willValidate || field.closest("[hidden]")) return "";
  const value = field.value;
  if (
    field.required &&
    !(field.type === "checkbox" ? field.checked : value.length)
  )
    return field.type === "checkbox"
      ? "Подтвердите этот пункт."
      : "Заполните это поле.";
  if (!value) return "";
  if (field.validity.typeMismatch)
    return field.type === "email"
      ? "Укажите email, например name@company.ru."
      : "Укажите полный адрес, например https://example.ru.";
  if (
    field.type === "password" &&
    field.minLength > 0 &&
    Array.from(value).length < field.minLength
  )
    return `Введите не менее ${field.minLength} символов.`;
  if (field.validity.tooShort)
    return `Введите не менее ${field.minLength} символов.`;
  if (field.maxLength > 0 && value.length > field.maxLength)
    return `Допустимо не более ${field.maxLength} символов.`;
  if (field.name === "repeat" && value !== field.form.elements.password.value)
    return "Пароли не совпадают. Повторите новый пароль.";
  if (field.validity.badInput) return "Введите число.";
  if (field.validity.rangeUnderflow)
    return `Минимальное значение — ${field.min}.`;
  if (field.validity.rangeOverflow)
    return `Максимальное значение — ${field.max}.`;
  if (field.validity.stepMismatch)
    return "Проверьте значение и допустимый шаг.";
  if (field.validity.patternMismatch) return "Проверьте формат значения.";
  return "";
}
function clearField(field) {
  const id = field.dataset.validationErrorId;
  if (!id) return;
  document.getElementById(id)?.remove();
  const remaining = (field.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .filter((value) => value && value !== id);
  if (remaining.length)
    field.setAttribute("aria-describedby", remaining.join(" "));
  else field.removeAttribute("aria-describedby");
  field.removeAttribute("aria-invalid");
  delete field.dataset.validationErrorId;
}
export function fieldError(field, text) {
  clearField(field);
  const id = `${field.form.id}-${field.name}-error`;
  const error = document.createElement("span");
  error.id = id;
  error.className = "field-error";
  // Keep validation text out of the label name; aria-describedby still exposes it as a description.
  error.setAttribute("aria-hidden", "true");
  error.textContent = text;
  field.insertAdjacentElement("afterend", error);
  field.dataset.validationErrorId = id;
  field.setAttribute("aria-invalid", "true");
  field.setAttribute(
    "aria-describedby",
    [field.getAttribute("aria-describedby"), id].filter(Boolean).join(" "),
  );
}
export function clearFormErrors(form) {
  for (const field of form.querySelectorAll("input,select,textarea"))
    clearField(field);
}
export function prepareForm(form) {
  form.noValidate = true;
  const update = (event) => {
    const field = event.target;
    if (field.dataset.validationErrorId) {
      const text = errorText(field);
      if (text) fieldError(field, text);
      else clearField(field);
    }
    const repeat = form.elements.namedItem("repeat");
    if (field.name === "password" && repeat?.dataset.validationErrorId) {
      const text = errorText(repeat);
      if (text) fieldError(repeat, text);
      else clearField(repeat);
    }
  };
  form.addEventListener("input", update);
  form.addEventListener("change", update);
}
export function validateForm(form) {
  clearFormErrors(form);
  let first;
  for (const field of form.querySelectorAll("input,select,textarea")) {
    const text = errorText(field);
    if (text) {
      fieldError(field, text);
      first ||= field;
    }
  }
  if (first) first.focus();
  return !first;
}
