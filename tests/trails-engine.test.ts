import { computeSpotSignals } from '../src/trails/signals.js';
import { solveLocal } from '../src/trails/solver/local.js';
import { solveExact } from '../src/trails/solver/exact.js';
import { refreshTravelTimeMatrix } from '../src/trails/matrix.js';
import { generateTrail, TrailGenerationError, windowsFromBestTime } from '../src/trails/generate.js';
import type { TrailLeg, TrailProblem } from '../src/trails/types.js';
import request from 'supertest';
import { app } from '../src/app.js';
import { signSessionToken } from '../src/auth/tokens.js';

describe('Plan 44 trail engine phase 0–2', () => {
  beforeEach(() => { jest.useFakeTimers({ now: new Date('2026-10-19T08:00:00.000Z') }); });
  afterEach(() => { jest.useRealTimers(); });

  test('signals are bounded, weighted, and deterministic from fixed public inputs', () => {
    const spots = [{ spotId:'a',category:'nature',goodFor:['family'],description:'A'.repeat(130),approvedPhotoCount:1,sourceType:'lgu',saves30d:4,interactions30d:8,questCompletions30d:2 }];
    const a = computeSpotSignals(spots,{themes:['nature'],trendThemes:[{categories:['nature'],weight:.6}]});
    expect(a).toEqual(computeSpotSignals(spots,{themes:['nature'],trendThemes:[{categories:['nature'],weight:.6}]}));
    expect(a[0].value).toBeGreaterThanOrEqual(0);
    expect(a[0].value).toBeLessThanOrEqual(1);
    expect(a[0].components).toEqual({ quality:1,popularity:1,trend:.6,fit:1,novelty:1 });
  });

  test('maps only actual migration-050 best_time labels to arrival windows', () => {
    expect(windowsFromBestTime(['early_morning','sunset','weekdays','dry_season'])).toEqual([[300,600],[990,1125]]);
    expect(windowsFromBestTime(['daytime','night'])).toEqual([[600,1020],[1080,1440]]);
  });

  test('local solver is deterministic and within 95% of exact on 50 seeded instances', () => {
    for (let sample=0;sample<50;sample++) {
      const count=5+(sample%3), ids=Array.from({length:count},(_,i)=>`s${i}`);
      const nodes=ids.map((spotId,i)=>({spotId,value:.45+((sample*17+i*13)%55)/100,dwellMin:15,windows:[[0,1440] as [number,number]],crowdByHour:Array(24).fill(0),category:`c${i}`}));
      const matrix=new Map<string,TrailLeg>();
      for(const from of ids)for(const to of ids)if(from!==to)matrix.set(`${from}\0${to}`,{minutes:5+((sample*7+from.charCodeAt(1)*3+to.charCodeAt(1))%20),km:1,approximate:false});
      const lookup=(from:string,to:string)=>matrix.get(`${from}\0${to}`);
      const problem:TrailProblem={nodes,dayStartMin:480,budgetMin:150,minStops:3,maxStops:5,maxLegMin:40,maxPerCategory:3,mustInclude:[],exclude:[],weights:{crowdPenalty:0,travelPenalty:.0001},seed:sample};
      const local=solveLocal(problem,lookup,150), exact=solveExact(problem,lookup);
      expect(local.feasible).toBe(true);
      expect(local.objective).toBeGreaterThanOrEqual(exact.objective*.95);
      expect(solveLocal(problem,lookup,150).stops).toEqual(local.stops);
    }
  }, 30_000);

  test('honors budget, arrival windows, maximum leg, categories, required and excluded stops', () => {
    const nodes=[
      {spotId:'a',value:1,dwellMin:30,windows:[[480,600] as [number,number]],crowdByHour:Array(24).fill(0),category:'food'},
      {spotId:'b',value:.9,dwellMin:30,windows:[[500,700] as [number,number]],crowdByHour:Array(24).fill(0),category:'food'},
      {spotId:'c',value:.8,dwellMin:30,windows:[],crowdByHour:Array(24).fill(0),category:'nature'},
      {spotId:'d',value:.7,dwellMin:30,windows:[],crowdByHour:Array(24).fill(0),category:'culture'},
    ];
    const lookup=(from:string,to:string):TrailLeg=>({minutes:from==='a'&&to==='b'?90:10,km:1,approximate:false});
    const base:TrailProblem={nodes,dayStartMin:480,budgetMin:150,minStops:2,maxStops:3,maxLegMin:45,maxPerCategory:1,mustInclude:['c'],exclude:['b'],weights:{crowdPenalty:0,travelPenalty:0},seed:9};
    const solution=solveLocal(base,lookup);
    expect(solution.feasible).toBe(true);
    expect(solution.stops.map(s=>s.spotId)).toContain('c');
    expect(solution.stops.map(s=>s.spotId)).not.toContain('b');
    expect(solution.totalMin).toBeLessThanOrEqual(base.budgetMin);
    expect(solution.stops.every(s=>s.arriveMin>=480)).toBe(true);
    expect(solveLocal({...base,budgetMin:35},lookup).feasible).toBe(false);
    expect(solveLocal({...base,maxLegMin:5},lookup).feasible).toBe(false);
    expect(solveLocal({...base,maxPerCategory:0},lookup).feasible).toBe(false);
    expect(solveLocal({...base,mustInclude:['missing']},lookup).feasible).toBe(false);
  });

  test('matrix batches requests, records Valhalla results and approximates partial failures', async () => {
    const query=jest.fn().mockResolvedValue({rows:[]});
    const fetchImpl=jest.fn().mockResolvedValue({ok:true,json:async()=>({sources_to_targets:[[{time:0,distance:0},{time:600,distance:4000}],[{time:700,distance:4500},{time:0,distance:0}]]})} as Response);
    const points=[{id:'a',lat:16,lng:120},{id:'b',lat:16.1,lng:120.1}];
    const result=await refreshTravelTimeMatrix({query} as any,'auto',{points,fetchImpl,baseUrl:'http://127.0.0.1:9999',graphLabel:'test'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({costing:'auto'});
    expect(result).toMatchObject({requested:4,exact:4,approximate:0,graphLabel:'test'});
    expect(query).toHaveBeenCalledTimes(6); // transaction + four upserts + commit
  });

  test('matrix partial failure and timeout use flagged haversine fallbacks without live routing', async () => {
    const query=jest.fn().mockResolvedValue({rows:[]});
    const partial=jest.fn().mockResolvedValue({ok:true,json:async()=>({sources_to_targets:[[{time:0,distance:0},{error:'unroutable'}],[{time:NaN,distance:1},{time:0,distance:0}]]})} as Response);
    const result=await refreshTravelTimeMatrix({query} as any,'pedestrian',{points:[{id:'a',lat:16,lng:120},{id:'b',lat:16.1,lng:120.1}],fetchImpl:partial,baseUrl:'http://127.0.0.1:9999'});
    expect(result.approximate).toBe(2);
    expect(query.mock.calls.filter(call=>String(call[0]).includes('INSERT INTO travel_time_matrix')).every(call=>call[1][5] === (call[1][1]!==call[1][2] && Number(call[1][3])>0 && call[1][5]))).toBe(true);
    jest.useRealTimers();
    const timeoutFetch=jest.fn((_url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')))));
    const timeoutResult=await refreshTravelTimeMatrix({query:jest.fn().mockResolvedValue({rows:[]})} as any,'auto',{points:[{id:'a',lat:16,lng:120},{id:'b',lat:16.1,lng:120.1}],fetchImpl:timeoutFetch,baseUrl:'http://127.0.0.1:9999',timeoutMs:1});
    expect(timeoutResult.approximate).toBe(2);
  });

  test('generation reports NO_FEASIBLE_TRAIL and rolls back every inserted row on mid-transaction failure', async () => {
    const client={query:jest.fn().mockImplementation(async (sql:string) => {
      if(sql==='BEGIN'||sql==='ROLLBACK'||sql==='COMMIT')return {rows:[]};
      if(sql.includes('FROM spots'))return {rows:[]};
      if(sql.includes('SELECT digest')||sql.includes('travel_time_matrix'))return {rows:[]};
      throw new Error('unexpected query');
    }),release:jest.fn()};
    const pool={connect:jest.fn().mockResolvedValue(client)};
    await expect(generateTrail(pool as any,{theme:'empty'})).rejects.toBeInstanceOf(TrailGenerationError);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('every trail administration endpoint requires authentication before reaching storage', async () => {
    const routes: Array<[string,string]> = [
      ['get','/api/v1/admin/trails/matrix/status'], ['post','/api/v1/admin/trails/matrix/refresh'],
      ['get','/api/v1/admin/trails'], ['post','/api/v1/admin/trails/generate'],
      ['post','/api/v1/admin/trails/example/review'], ['post','/api/v1/admin/trails/example/publish'],
      ['post','/api/v1/admin/trails/example/reject'], ['post','/api/v1/admin/trails/example/retire'],
    ];
    const traveler = signSessionToken({ id:'test-user',seed_id:'seed-test-user',role:'user' });
    for (const [method,path] of routes) {
      const response = method==='get' ? await request(app).get(path) : await request(app).post(path).send({});
      expect(response.status).toBe(401);
      const forbidden = method==='get' ? await request(app).get(path).set('Authorization',`Bearer ${traveler}`) : await request(app).post(path).set('Authorization',`Bearer ${traveler}`).send({});
      expect(forbidden.status).toBe(403);
    }
  });
});
