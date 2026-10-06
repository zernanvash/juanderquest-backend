import { localMonth, monthlyWindow, nextMonth, selectMonthlyCandidates, themeForPeriod, MonthlyCandidate } from '../src/juanchoice/monthly-policy.js';

const themes = [
  {name:'Nature and coast',categories:['nature_outdoors']},
  {name:'Culture and heritage',categories:['culture_heritage']},
];
const candidate = (id:string,municipality:string,partial:Partial<MonthlyCandidate>={}):MonthlyCandidate => ({
  id,municipality,category:'nature_outdoors',last_nominated_at:null,last_won_at:null,
  recommendation_suppressed:false,crowd_status:'unknown',...partial,
});

describe('JuanChoice monthly policy',()=>{
  it('uses all seven Manila calendar days and closes at the exclusive boundary',()=>{
    const october=monthlyWindow('2026-10-01','Asia/Manila');
    expect(october.opensAt.toISOString()).toBe('2026-09-30T16:00:00.000Z');
    expect(october.closesAt.toISOString()).toBe('2026-10-07T16:00:00.000Z');
    expect(october.closesAt.getTime()-october.opensAt.getTime()).toBe(7*86400000);
    expect(localMonth(new Date('2026-09-30T15:59:59Z'),'Asia/Manila')).toBe('2026-09-01');
    expect(localMonth(october.opensAt,'Asia/Manila')).toBe('2026-10-01');
  });

  it('handles year and leap-month boundaries without changing the seven-day window',()=>{
    expect(nextMonth('2026-12-01')).toBe('2027-01-01');
    expect(nextMonth('2028-02-01')).toBe('2028-03-01');
    const february=monthlyWindow('2028-02-01','Asia/Manila');
    expect(february.closesAt.getTime()-february.opensAt.getTime()).toBe(7*86400000);
    expect(monthlyWindow('2028-12-01','Asia/Manila').opensAt.toISOString()).toBe('2028-11-30T16:00:00.000Z');
  });

  it('rotates supported themes from the configured first month',()=>{
    expect(themeForPeriod('2026-10-01',themes,'2026-10-01').name).toBe('Nature and coast');
    expect(themeForPeriod('2026-11-01',themes,'2026-10-01').name).toBe('Culture and heritage');
    expect(themeForPeriod('2026-12-01',themes,'2026-10-01').name).toBe('Nature and coast');
  });

  it('selects deterministically, keeps municipality diversity and excludes recent winners/unsafe spots',()=>{
    const input = {period:'2026-10-01',themes,primaryTheme:themes[0],minimum:2,target:4,
      cooldownMs:90*86400000,closesAt:new Date('2026-09-30T16:00:00Z'),candidates:[
        candidate('a','Bolinao'),candidate('b','Bolinao'),candidate('c','Bolinao'),
        candidate('d','Alaminos'),candidate('e','Alaminos'),candidate('f','Anda'),
        candidate('recent-winner','Lingayen',{last_won_at:'2026-09-01T00:00:00Z'}),
        candidate('busy','Bani',{crowd_status:'estimated_busy'}),
        candidate('suppressed','Sual',{recommendation_suppressed:true}),
      ]};
    const first=selectMonthlyCandidates(input);
    const second=selectMonthlyCandidates({...input,candidates:[...input.candidates].reverse()});
    expect(first?.selected.map(item=>item.id)).toEqual(second?.selected.map(item=>item.id));
    expect(first?.selected).toHaveLength(4);
    expect(first?.selected.map(item=>item.municipality).filter(name=>name==='Bolinao')).toHaveLength(2);
    expect(first?.selected.some(item=>['recent-winner','busy','suppressed'].includes(item.id))).toBe(false);
  });

  it('falls back to a different theme, then postpones when no theme has two destinations',()=>{
    const input={period:'2026-10-01',themes,primaryTheme:themes[0],minimum:2,target:4,
      cooldownMs:90*86400000,closesAt:new Date('2026-09-30T16:00:00Z'),
      candidates:[candidate('heritage-1','Dagupan',{category:'culture_heritage'}),
        candidate('heritage-2','Lingayen',{category:'culture_heritage'})]};
    expect(selectMonthlyCandidates(input)?.theme.name).toBe('Culture and heritage');
    expect(selectMonthlyCandidates({...input,candidates:input.candidates.slice(0,1)})).toBeNull();
  });
});
