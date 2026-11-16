export function csvCell(value){
  let text=String(value??'');
  if(/^\s*[=+@-]/u.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export function toCsv(rows,columns){
  return '\uFEFF'+[columns.map(csvCell).join(','),...rows.map(row=>columns.map(key=>csvCell(row[key])).join(','))].join('\r\n');
}
