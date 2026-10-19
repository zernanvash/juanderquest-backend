const fs = require('fs');

const areasPath = '/mnt/c/Users/HP/Desktop/Code/JuanderQuest/web_app/src/lib/areas.ts';
const areasContent = fs.readFileSync(areasPath, 'utf8');
const knownLgus = [];
const areaRegex = /id:\s*['"]([^'"]+)['"],\s*name:\s*['"]([^'"]+)['"],\s*type:\s*['"](city|municipality)['"]/g;
let m;
while ((m = areaRegex.exec(areasContent)) !== null) {
  knownLgus.push({ id: m[1], name: m[2], type: m[3] });
}

const towns = JSON.parse(fs.readFileSync('/home/kaizo/jdq-maps/pangasinan-faeldon-towns.json', 'utf8')).features;
console.log('Known LGUs:', knownLgus.length, 'Faeldon towns:', towns.length);

const matched = [];
const unmatched = [];

for (const k of knownLgus) {
  const normK = k.name.toLowerCase().replace(/ city$/, '');
  const found = towns.find(t => {
    const tName = t.properties.adm3_en.toLowerCase().replace(/^city of /, '');
    return tName === normK || tName === k.name.toLowerCase();
  });
  if (found) {
    matched.push({ id: k.id, name: k.name, psgc: found.properties.adm3_psgc, adm3_en: found.properties.adm3_en });
  } else {
    unmatched.push(k);
  }
}

console.log('Matched LGUs:', matched.length, 'Unmatched LGUs:', unmatched.length);
if (unmatched.length > 0) {
  console.log('Unmatched:', unmatched);
} else {
  console.log('ALL 48 LGUs MATCHED PERFECTLY with PSA/NAMRIA PSGC codes!');
}
