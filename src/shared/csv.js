export function csvCell(value){
  let text=String(value??'');
  if(/^[\u0000-\u0020]*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export function toCsv(rows,columns){
  return '\uFEFF'+[columns.join(','),...rows.map(row=>columns.map(key=>csvCell(row[key])).join(','))].join('\r\n');
}
