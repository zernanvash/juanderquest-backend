import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export type SpotCategory = 'eat_drink' | 'nature_outdoors' | 'culture_heritage' | 'activities_wellness' | 'shopping_local' | 'stay';
export type SpotTrust = 'lgu_verified' | 'editorial' | 'open_data' | 'community';
export type SpotSource = 'lgu' | 'editorial' | 'open_data' | 'community';

export interface Spot {
  id: string; slug: string; name: string; description: string;
  category: SpotCategory; subcategory: string; tags: string[];
  municipality: string; address: string; gps_lat: number; gps_lng: number;
  price_level: number; hours: Record<string, string>; amenities: string[];
  image_url: string; asset_ids?: string[]; source_type: SpotSource; source_name: string; source_url?: string;
  trust_level: SpotTrust; status: 'published' | 'needs_review' | 'unpublished';
  quest_id?: string; created_by?: string; created_at: string; updated_at: string;
}

export interface DiscoveryPreferences {
  categories: SpotCategory[]; tags: string[]; occasions: string[];
  price_levels: number[]; radius_km: number; onboarding_state: 'pending' | 'completed' | 'skipped';
}

export const taxonomy = [
  { id: 'eat_drink', label: 'Eat & Drink', subcategories: ['restaurant', 'carinderia', 'cafe', 'bakery', 'street_food', 'bar'] },
  { id: 'nature_outdoors', label: 'Nature & Outdoors', subcategories: ['beach', 'waterfall', 'cave', 'park', 'trailhead', 'viewpoint'] },
  { id: 'culture_heritage', label: 'Culture & Heritage', subcategories: ['church', 'museum', 'heritage_site', 'arts_crafts'] },
  { id: 'activities_wellness', label: 'Activities & Wellness', subcategories: ['sports_venue', 'running_spot', 'gym', 'recreation', 'water_activity'] },
  { id: 'shopping_local', label: 'Shopping & Local Finds', subcategories: ['market', 'souvenir', 'local_products'] },
  { id: 'stay', label: 'Stay', subcategories: ['hotel', 'resort', 'homestay', 'campsite'] },
] as const;

const now = new Date().toISOString();
const seeds: Spot[] = [
  { id:'spot-hundred-islands',slug:'hundred-islands-national-park',name:'Hundred Islands National Park',description:'Island-hopping, viewpoints, swimming, and family adventures across the iconic Alaminos archipelago.',category:'nature_outdoors',subcategory:'park',tags:['island','family','scenic','water_activity'],municipality:'Alaminos City',address:'Lucap, Alaminos City, Pangasinan',gps_lat:16.2063,gps_lng:119.9706,price_level:2,hours:{daily:'06:00-17:00'},amenities:['parking','restroom','boat_rental'],image_url:'',source_type:'lgu',source_name:'Alaminos City Tourism',trust_level:'lgu_verified',status:'published',quest_id:'q1111111-1111-1111-1111-111111111111',created_at:now,updated_at:now },
  { id:'spot-patar',slug:'patar-white-beach',name:'Patar White Beach',description:'A broad public beach known for golden sunsets, limestone scenery, and relaxed group trips.',category:'nature_outdoors',subcategory:'beach',tags:['beach','sunset','friends','scenic'],municipality:'Bolinao',address:'Patar, Bolinao, Pangasinan',gps_lat:16.3204,gps_lng:119.7847,price_level:1,hours:{daily:'05:00-20:00'},amenities:['parking','restroom','food_stalls'],image_url:'',source_type:'lgu',source_name:'Bolinao Tourism Office',trust_level:'lgu_verified',status:'published',created_at:now,updated_at:now },
  { id:'spot-manaoag',slug:'minor-basilica-of-manaoag',name:'Minor Basilica of Our Lady of Manaoag',description:'A major pilgrimage and heritage destination surrounded by local food and souvenir stalls.',category:'culture_heritage',subcategory:'church',tags:['heritage','family','pilgrimage','architecture'],municipality:'Manaoag',address:'Milo St, Manaoag, Pangasinan',gps_lat:16.0436,gps_lng:120.4854,price_level:0,hours:{daily:'05:00-19:00'},amenities:['parking','restroom','wheelchair_accessible'],image_url:'',source_type:'open_data',source_name:'OpenStreetMap contributors',source_url:'https://www.openstreetmap.org/',trust_level:'open_data',status:'published',created_at:now,updated_at:now },
  { id:'spot-bangus',slug:'dagupan-bangus-market',name:'Dagupan Bangus Market',description:'Discover fresh Dagupan bangus and local seafood cooking near the city market district.',category:'eat_drink',subcategory:'street_food',tags:['seafood','local_food','market','budget'],municipality:'Dagupan City',address:'Downtown Dagupan City, Pangasinan',gps_lat:16.0431,gps_lng:120.3333,price_level:1,hours:{daily:'05:00-18:00'},amenities:['parking','takeaway'],image_url:'',source_type:'editorial',source_name:'JuanDerQuest Curators',trust_level:'editorial',status:'published',quest_id:'q5555555-5555-5555-5555-555555555555',created_at:now,updated_at:now },
  { id:'spot-lingayen',slug:'lingayen-baywalk',name:'Lingayen Baywalk',description:'An open waterfront for sunset walks, casual running, cycling, and family recreation.',category:'activities_wellness',subcategory:'running_spot',tags:['running','walking','sunset','family','free'],municipality:'Lingayen',address:'Capitol Beachfront, Lingayen, Pangasinan',gps_lat:16.0218,gps_lng:120.2319,price_level:0,hours:{daily:'04:30-22:00'},amenities:['parking','restroom','wheelchair_accessible'],image_url:'',source_type:'lgu',source_name:'Province of Pangasinan',trust_level:'lgu_verified',status:'published',created_at:now,updated_at:now },
  { id:'spot-cafe',slug:'third-wave-cafe-dagupan',name:'Third Wave Café Dagupan',description:'A quiet local coffee stop suited for meetups, remote work, and an afternoon break.',category:'eat_drink',subcategory:'cafe',tags:['coffee','quiet','work_friendly','friends'],municipality:'Dagupan City',address:'Arellano Street, Dagupan City, Pangasinan',gps_lat:16.0470,gps_lng:120.3400,price_level:2,hours:{daily:'08:00-21:00'},amenities:['wifi','restroom','power_outlets'],image_url:'',source_type:'community',source_name:'JuanDerQuest Community',trust_level:'community',status:'published',created_at:now,updated_at:now },
  { id:'spot-bolinao-falls',slug:'bolinao-falls-1',name:'Bolinao Falls 1',description:'A forest waterfall and swimming destination popular with adventurous groups.',category:'nature_outdoors',subcategory:'waterfall',tags:['hidden_gem','swimming','friends','adventure'],municipality:'Bolinao',address:'Samang Norte, Bolinao, Pangasinan',gps_lat:16.3377,gps_lng:119.8806,price_level:1,hours:{daily:'07:00-17:00'},amenities:['parking','guide'],image_url:'',source_type:'open_data',source_name:'OpenStreetMap contributors',source_url:'https://www.openstreetmap.org/',trust_level:'open_data',status:'published',created_at:now,updated_at:now },
  { id:'spot-capitol',slug:'pangasinan-provincial-capitol',name:'Pangasinan Provincial Capitol',description:'A landmark neoclassical capitol complex with lawns, heritage architecture, and bay access.',category:'culture_heritage',subcategory:'heritage_site',tags:['architecture','history','family','free'],municipality:'Lingayen',address:'Capitol Complex, Lingayen, Pangasinan',gps_lat:16.0232,gps_lng:120.2317,price_level:0,hours:{weekdays:'08:00-17:00'},amenities:['parking','wheelchair_accessible'],image_url:'',source_type:'lgu',source_name:'Province of Pangasinan',trust_level:'lgu_verified',status:'published',created_at:now,updated_at:now },
];

const radians = (value:number) => value * Math.PI / 180;
export const distanceKm = (aLat:number,aLng:number,bLat:number,bLng:number) => {
  const dLat=radians(bLat-aLat), dLng=radians(bLng-aLng);
  const h=Math.sin(dLat/2)**2+Math.cos(radians(aLat))*Math.cos(radians(bLat))*Math.sin(dLng/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
};

export class SpotStore {
  spots = [...seeds];
  preferences = new Map<string, DiscoveryPreferences>();
  interactions = new Map<string, Set<string>>();
  private pg: Pool | null = null;

  async hydrateFromPg(pool: Pool) {
    this.pg = pool;
    const { rows } = await pool.query('SELECT * FROM spots WHERE status = $1 ORDER BY created_at', ['published']);
    if (rows.length) this.spots = rows.map((r:any)=>({...r,tags:r.tags||[],amenities:r.amenities||[],hours:r.hours||{},created_at:new Date(r.created_at).toISOString(),updated_at:new Date(r.updated_at).toISOString()}));
    else for (const spot of this.spots) await this.persistSpot(spot);
    const { rows: preferences } = await pool.query('SELECT * FROM discovery_preferences');
    for (const p of preferences) this.preferences.set(p.user_id, { categories:p.categories||[],tags:p.tags||[],occasions:p.occasions||[],price_levels:p.price_levels||[],radius_km:p.radius_km,onboarding_state:p.onboarding_state });
    const { rows: interactions } = await pool.query('SELECT * FROM spot_interactions');
    for (const item of interactions) { const values=this.interactions.get(item.user_id)||new Set<string>();values.add(`${item.spot_id}:${item.interaction_type}`);this.interactions.set(item.user_id,values); }
  }

  private async persistSpot(s: Spot) {
    if (!this.pg) return;
    await this.pg.query(`INSERT INTO spots (id,slug,name,description,category,subcategory,tags,municipality,address,gps_lat,gps_lng,price_level,hours,amenities,image_url,source_type,source_name,source_url,trust_level,status,quest_id,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,updated_at=EXCLUDED.updated_at`,[s.id,s.slug,s.name,s.description,s.category,s.subcategory,JSON.stringify(s.tags),s.municipality,s.address,s.gps_lat,s.gps_lng,s.price_level,JSON.stringify(s.hours),JSON.stringify(s.amenities),s.image_url,s.source_type,s.source_name,s.source_url||null,s.trust_level,s.status,s.quest_id||null,s.created_by||null,s.created_at,s.updated_at]);
  }

  getPreferences(userId:string): DiscoveryPreferences { return this.preferences.get(userId) || {categories:[],tags:[],occasions:[],price_levels:[],radius_km:25,onboarding_state:'pending'}; }
  setPreferences(userId:string,p:DiscoveryPreferences) { this.preferences.set(userId,p); if(this.pg)this.pg.query(`INSERT INTO discovery_preferences(user_id,categories,tags,occasions,price_levels,radius_km,onboarding_state) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET categories=$2,tags=$3,occasions=$4,price_levels=$5,radius_km=$6,onboarding_state=$7,updated_at=NOW()`,[userId,JSON.stringify(p.categories),JSON.stringify(p.tags),JSON.stringify(p.occasions),JSON.stringify(p.price_levels),p.radius_km,p.onboarding_state]).catch(()=>{}); return p; }
  interact(userId:string,spotId:string,type:string,enabled=true) { const key=`${spotId}:${type}`; const set=this.interactions.get(userId)||new Set<string>(); enabled?set.add(key):set.delete(key); this.interactions.set(userId,set);if(this.pg){const query=enabled?'INSERT INTO spot_interactions(user_id,spot_id,interaction_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING':'DELETE FROM spot_interactions WHERE user_id=$1 AND spot_id=$2 AND interaction_type=$3';this.pg.query(query,[userId,spotId,type]).catch(()=>{});} return enabled; }
  isSaved(userId:string|undefined,spotId:string){return !!userId&&this.interactions.get(userId)?.has(`${spotId}:save`);}
  trend(spotId:string){let score=0;for(const values of this.interactions.values()){if(values.has(`${spotId}:visit`))score+=5;if(values.has(`${spotId}:directions`))score+=3;if(values.has(`${spotId}:save`))score+=2;if(values.has(`${spotId}:helpful`))score+=2;if(values.has(`${spotId}:view`))score+=.25;}return score;}

  list(q:{search?:string;categories?:string[];tags?:string[];municipality?:string;lat?:number;lng?:number;radius?:number;intent?:string;sort?:string;hasQuest?:boolean;userId?:string}) {
    const prefs=q.userId?this.getPreferences(q.userId):undefined;
    return this.spots.filter(s=>s.status==='published').map(s=>{
      const distance=q.lat!==undefined&&q.lng!==undefined?distanceKm(q.lat,q.lng,s.gps_lat,s.gps_lng):undefined;
      const intent=(q.intent||'').toLowerCase();
      const intentMatch=intent&&[s.category,s.subcategory,...s.tags,s.name].some(v=>v.toLowerCase().includes(intent))?1:0;
      const prefMatch=prefs&&([...prefs.categories,...prefs.tags].some(v=>v===s.category||s.tags.includes(v)))?1:0;
      const distanceScore=distance===undefined?.5:Math.max(0,1-distance/Math.max(q.radius||50,1));
      const trust={lgu_verified:1,editorial:.9,open_data:.75,community:.6}[s.trust_level];
      const trend=Math.min(1,this.trend(s.id)/20);
      const ageDays=(Date.now()-Date.parse(s.created_at))/86400000;
      const freshness=Math.max(0,1-ageDays/30);
      const score=intentMatch*.30+prefMatch*.20+distanceScore*.20+trust*.15+trend*.10+freshness*.05;
      const reasons:string[]=[];if(distance!==undefined)reasons.push(`${distance<1?Math.round(distance*1000)+' m':distance.toFixed(1)+' km'} away`);if(intentMatch)reasons.push(`Matches ${q.intent}`);if(s.trust_level==='lgu_verified')reasons.push('LGU verified');if(trend>.25)reasons.push(`Trending in ${s.municipality}`);
      return {...s,distance_km:distance,recommendation_score:Number(score.toFixed(4)),recommendation_reasons:reasons,saved:this.isSaved(q.userId,s.id),trend_score:this.trend(s.id)};
    }).filter(s=>(!q.search||`${s.name} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(q.search.toLowerCase()))&&(!q.categories?.length||q.categories.includes(s.category))&&(!q.tags?.length||q.tags.some(t=>s.tags.includes(t)))&&(!q.municipality||s.municipality.toLowerCase()===q.municipality.toLowerCase())&&(!q.hasQuest||!!s.quest_id)&&(s.distance_km===undefined||!q.radius||s.distance_km<=q.radius)).sort((a,b)=>q.sort==='nearest'?(a.distance_km??999)-(b.distance_km??999):q.sort==='newest'?Date.parse(b.created_at)-Date.parse(a.created_at):q.sort==='trending'?b.trend_score-a.trend_score:b.recommendation_score-a.recommendation_score);
  }

  create(input:Omit<Spot,'id'|'slug'|'source_type'|'source_name'|'trust_level'|'status'|'created_at'|'updated_at'>,userId:string){
    const duplicate=this.spots.find(s=>distanceKm(input.gps_lat,input.gps_lng,s.gps_lat,s.gps_lng)<.05&&s.name.toLowerCase().includes(input.name.toLowerCase().slice(0,5)));
    if(duplicate) return {duplicate};
    const timestamp=new Date().toISOString();const slug=`${input.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}-${randomUUID().slice(0,6)}`;
    const spot:Spot={...input,id:randomUUID(),slug,source_type:'community',source_name:'JuanDerQuest Community',trust_level:'community',status:'published',created_by:userId,created_at:timestamp,updated_at:timestamp};this.spots.push(spot);this.persistSpot(spot).catch(()=>{});return {spot};
  }
}

export const spotStore = new SpotStore();
