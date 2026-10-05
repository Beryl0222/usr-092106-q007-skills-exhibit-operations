/**
 * 无依赖的 JSON Schema 子集校验器，覆盖本仓库契约实际使用的关键字：
 * type / const / enum / required / properties / items / $ref(#/definitions) /
 * allOf(if-then) / minLength / minimum / minItems / format(date-time) /
 * additionalProperties(布尔) / type 数组（可空）。
 * 返回错误信息数组，空数组表示通过。
 */

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function resolveRef(ref, root) {
  const path = ref.replace(/^#\//, "").split("/");
  return path.reduce((node, key) => node[key], root);
}

function checkType(value, type) {
  if (Array.isArray(type)) return type.some((t) => checkType(value, t));
  if (value === null) return type === "null";
  if (Array.isArray(value)) return type === "array";
  if (Number.isInteger(value)) return type === "integer" || type === "number";
  if (typeof value === "number") return type === "number";
  return typeof value === type;
}

function validateNode(value, schema, root, path, errors) {
  if (schema.$ref) schema = resolveRef(schema.$ref, root);

  if (schema.type && !checkType(value, schema.type)) {
    errors.push(`${path} 类型应为 ${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}`);
    return; // 类型不符时继续下钻只会产生噪声
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} 应为常量 ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} 必须是枚举值之一：${schema.enum.join("、")}`);
  }
  if (schema.format === "date-time" && (typeof value !== "string" || !ISO_DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) {
    errors.push(`${path} 必须是带时区的 ISO 日期时间`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} 长度不得小于 ${schema.minLength}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} 不得小于 ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} 至少要有 ${schema.minItems} 项`);
    if (schema.items) value.forEach((item, i) => validateNode(item, schema.items, root, `${path}[${i}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) errors.push(`${path} 缺少字段：${key}`);
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) validateNode(value[key], sub, root, `${path}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path} 不允许额外字段：${key}`);
      }
    }
  }
  if (schema.allOf) {
    for (const branch of schema.allOf) validateNode(value, branch, root, path, errors);
  }
  if (schema.if) {
    const probe = [];
    validateNode(value, schema.if, root, path, probe);
    const applies = probe.length === 0;
    const branch = applies ? schema.then : schema.else;
    if (branch) validateNode(value, branch, root, path, errors);
  }
}

export function validateAgainstSchema(record, schema) {
  const errors = [];
  validateNode(record, schema, schema, "$", errors);
  return errors;
}
