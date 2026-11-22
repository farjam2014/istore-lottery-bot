export function csvCell(value){
  let text=String(value??'');
  if(/^[\s\uFEFF]*[=+\-@]/.test(text)||/^[\u0000-\u001F\u007F]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export function toCsv(rows,columns){
  return '\uFEFF'+[columns.join(','),...rows.map(row=>columns.map(key=>csvCell(row[key])).join(','))].join('\r\n');
}
