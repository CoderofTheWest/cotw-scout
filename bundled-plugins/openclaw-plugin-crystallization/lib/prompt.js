function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    return values[key] ?? '';
  });
}

function generateApprovalRequest({ template, trait, principle, count }) {
  return fillTemplate(template, {
    trait,
    principle,
    count
  });
}

module.exports = {
  generateApprovalRequest
};
