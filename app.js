
// PERIMETR iOS Demo (3D) - Mapbox GL JS
const $ = (id) => document.getElementById(id);
function bindTap(id, fn){
  const el = typeof id === 'string' ? $(id) : id;
  if(!el) return;
  let locked = false;
  const run = (e)=>{
    if(locked) return;
    locked = true;
    try{ fn(e); } finally { setTimeout(()=>{ locked=false; }, 350); }
  };
  // Prefer pointer events; fallback to click only (avoid touchend double-fire)
  if(window.PointerEvent){
    el.addEventListener('pointerup', run, {passive:true});
  } else {
    el.addEventListener('click', run, false);
  }
}


const screens = ["Login","Home","Setup","Incidents","Scenario","Map"].reduce((a,n)=>{a[n]=$("screen"+n);return a;},{});
function go(name){
  Object.values(screens).forEach(s=>s.classList.remove("active"));
  screens[name].classList.add("active");
  if(name==="Map"){ setTimeout(()=>{ if(map) map.resize(); }, 150); }
}

// GPS badge
const statusDot = $("statusDot"), statusText = $("statusText");
function setGpsStatus(mode){
  if(mode==="ok"){ statusDot.className="dot ok"; statusText.textContent="GPS: OK"; }
  else if(mode==="denied"){ statusDot.className="dot bad"; statusText.textContent="GPS: Denied"; }
  else { statusDot.className="dot"; statusText.textContent="GPS: Not requested"; }
}

// Demo auth
let session = JSON.parse(localStorage.getItem("perimetr_session")||"null");
function saveSession(){ localStorage.setItem("perimetr_session", JSON.stringify(session)); }
function clearSession(){ localStorage.removeItem("perimetr_session"); session=null; }
function deptKey(){ return `perimetr_incidents_${(session?.dept||"").toLowerCase().trim()}`; }

// Mapbox token management
function getToken(){ return localStorage.getItem("perimetr_mapbox_token") || ""; }
function setToken(t){ localStorage.setItem("perimetr_mapbox_token", t); }
$("mbToken").value = getToken();
$("btnSaveToken").onclick = ()=> {
  const t = ($("mbToken").value||"").trim();
  if(!t || !t.startsWith("pk.")) return alert("Paste a public Mapbox token that starts with pk.");
  setToken(t);
  alert("Saved. You can login now.");
};

// App state
let incidents = [];
let minutes = 5;
let method = "foot";
let direction = "unknown";
let incident = null; // {lat,lng,label}
let updates = [];
function resetPointStates(){}

let pointStates=[{status:'unassigned'},{status:'unassigned'},{status:'unassigned'},{status:'unassigned'}];

let pickMode = false;
let mapStyle = "streets";

// Controls
$("minSlider").oninput = (e)=>{ minutes=Number(e.target.value); $("minLabel").textContent=minutes; };
document.querySelectorAll("#methodGrid .chip").forEach(c=>c.onclick=()=>{
  method=c.dataset.method;
  document.querySelectorAll("#methodGrid .chip").forEach(x=>x.classList.toggle("active", x.dataset.method===method));
});
document.querySelectorAll("#dirGrid .chip").forEach(c=>c.onclick=()=>{
  direction=c.dataset.dir;
  document.querySelectorAll("#dirGrid .chip").forEach(x=>x.classList.toggle("active", x.dataset.dir===direction));
});
document.querySelectorAll("#mapStyleGrid .chip").forEach(c=>c.onclick=()=>{
  mapStyle=c.dataset.style;
  document.querySelectorAll("#mapStyleGrid .chip").forEach(x=>x.classList.toggle("active", x.dataset.style===mapStyle));
  applyStyle();
});

$("btnScenario").onclick = ()=>go("Scenario");
$("btnBackHome3").onclick = ()=>go("Home");
$("btnJumpScenario").onclick = async ()=>{
  try{
    resetPointStates();
    minutes=5; method="foot"; direction="N";
    $("minSlider").value=minutes; $("minLabel").textContent=minutes;
    document.querySelectorAll("#methodGrid .chip").forEach(x=>x.classList.toggle("active", x.dataset.method===method));
    document.querySelectorAll("#dirGrid .chip").forEach(x=>x.classList.toggle("active", x.dataset.dir===direction));
    const g = await mbGeocode("Miramar Parkway & Flamingo Road, Miramar, FL");
    await setIncident(g.lat, g.lng, "Scenario");
    go("Map");
    await drawPerimeter();
  }catch(e){ console.error(e); alert("Scenario failed. Check token/network."); }
};

// Navigation
$("btnBackSetup").onclick = ()=>{ pickMode=false; $("pickHint").style.display="none"; go("Setup"); };
$("btnTapToSet").onclick = ()=> {
  ensureMap();
  pickMode = true;
  $("pickHint").style.display = "block";
  $("mapTitle").textContent = "Tap map to set incident";
  go("Map");
};

$("btnClear").onclick = ()=>{ incident=null; resetPointStates(); $("addr").value=""; $("addrHelp").textContent="After setting a location, generate the perimeter."; alert("Cleared."); };

// Storage
function loadIncidents(){ try{ incidents = JSON.parse(localStorage.getItem(deptKey())||"[]"); }catch{ incidents=[]; } }
function saveIncidents(){ localStorage.setItem(deptKey(), JSON.stringify(incidents)); }

// Geometry model (smaller foot)
const speeds_mpm = { foot: 80.4672, vehicle: 536.448 };
function baseMeters(){
  const base = speeds_mpm[method]*minutes;
  const mult = { foot:0.62, vehicle:0.82 };
  return base*mult[method];
}
function metersToLat(m){ return m/111320; }
function metersToLng(m,lat){ return m/(111320*Math.cos(lat*Math.PI/180)); }
function rectScales(){ return method==="vehicle" ? {x:1.0,y:0.65}:{x:0.82,y:0.82}; }
function directionOffset(lat){
  const dist = baseMeters(), frac=0.30;
  const dy = metersToLat(dist*frac);
  const dx = metersToLng(dist*frac, lat);
  if(direction==="N") return {dLat:+dy,dLng:0};
  if(direction==="S") return {dLat:-dy,dLng:0};
  if(direction==="E") return {dLat:0,dLng:+dx};
  if(direction==="W") return {dLat:0,dLng:-dx};
  return {dLat:0,dLng:0};
}
function computeCorners(lat,lng,shrink=1){
  const dist = baseMeters()*shrink;
  const s = rectScales();
  const dLat = metersToLat(dist*s.y);
  const dLng = metersToLng(dist*s.x, lat);
  const off = directionOffset(lat);
  const cLat = lat+off.dLat, cLng = lng+off.dLng;
  return [
    {name:"1",corner:"NW",lat:cLat+dLat,lng:cLng-dLng},
    {name:"2",corner:"NE",lat:cLat+dLat,lng:cLng+dLng},
    {name:"3",corner:"SE",lat:cLat-dLat,lng:cLng+dLng},
    {name:"4",corner:"SW",lat:cLat-dLat,lng:cLng-dLng},
  ];
}

// --- Outward routing perimeter (preferred) ---
// Compute a lat/lng offset given bearing (deg) and distance (m)
function offsetLatLng(lat, lng, bearingDeg, distanceM){
  const R = 6378137;
  const br = bearingDeg * Math.PI/180;
  const lat1 = lat * Math.PI/180;
  const lng1 = lng * Math.PI/180;
  const dr = distanceM / R;
  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(dr) + Math.cos(lat1)*Math.sin(dr)*Math.cos(br));
  const lng2 = lng1 + Math.atan2(Math.sin(br)*Math.sin(dr)*Math.cos(lat1), Math.cos(dr)-Math.sin(lat1)*Math.sin(lat2));
  return { lat: lat2*180/Math.PI, lng: lng2*180/Math.PI };
}
function haversineM(aLat,aLng,bLat,bLng){
  const R=6378137;
  const dLat=(bLat-aLat)*Math.PI/180;
  const dLng=(bLng-aLng)*Math.PI/180;
  const s1=Math.sin(dLat/2), s2=Math.sin(dLng/2);
  const x=s1*s1 + Math.cos(aLat*Math.PI/180)*Math.cos(bLat*Math.PI/180)*s2*s2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(x)));
}

function bearingDeg(fromLat, fromLng, toLat, toLng){
  const y = Math.sin((toLng-fromLng)*Math.PI/180) * Math.cos(toLat*Math.PI/180);
  const x = Math.cos(fromLat*Math.PI/180)*Math.sin(toLat*Math.PI/180) -
            Math.sin(fromLat*Math.PI/180)*Math.cos(toLat*Math.PI/180)*Math.cos((toLng-fromLng)*Math.PI/180);
  let br = Math.atan2(y,x) * 180/Math.PI;
  br = (br + 360) % 360;
  return br;
}
function angDiff(a,b){
  let d = Math.abs(a-b) % 360;
  if(d>180) d = 360-d;
  return d;
}
function pointInPoly(lng,lat, ring){
  // ring: [[lng,lat],...], not closed required
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0], yi=ring[i][1];
    const xj=ring[j][0], yj=ring[j][1];
    const intersect = ((yi>lat)!==(yj>lat)) && (lng < (xj-xi)*(lat-yi)/(yj-yi+1e-12) + xi);
    if(intersect) inside = !inside;
  }
  return inside;
}
function sortByAngleAroundIncident(pts){
  return pts.slice().sort((a,b)=>{
    const aa = Math.atan2(a.lat-incident.lat, a.lng-incident.lng);
    const bb = Math.atan2(b.lat-incident.lat, b.lng-incident.lng);
    return aa-bb;
  });
}
function profileForMethod(){ return (method==="vehicle") ? "driving" : "walking"; }

// Pull ordered intersection locations from a Directions response (steps=true)
function extractIntersections(d){
  const route = d.routes?.[0];
  const legs = route?.legs?.[0];
  const steps = legs?.steps || [];
  const out=[];
  for(const st of steps){
    const ints = st.intersections || [];
    for(const it of ints){
      if(it?.location?.length===2){
        out.push({lng: it.location[0], lat: it.location[1]});
      }
    }
  }
  // de-duplicate nearby
  const filtered=[];
  for(const p of out){
    const last = filtered[filtered.length-1];
    if(!last || haversineM(last.lat,last.lng,p.lat,p.lng) > 12) filtered.push(p);
  }
  return filtered;
}

// Route outward in a bearing direction and choose an intersection near targetMeters
async function routeOutwardPoint(bearingDeg, targetMeters){
  const token = getToken();
  const profile = profileForMethod();
  // Make a far destination so we actually hit multiple intersections.
  const dest = offsetLatLng(incident.lat, incident.lng, bearingDeg, Math.max(targetMeters*1.35, 450));
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${incident.lng},${incident.lat};${dest.lng},${dest.lat}` +
              `?access_token=${encodeURIComponent(token)}&overview=false&steps=true&alternatives=false&geometries=geojson`;
  const data = await fetchJsonRetry(url, 3);
  const ints = extractIntersections(data);
  if(ints.length < 2){
    // fallback: snap destination to routable waypoint
    const wp = data.waypoints?.[1]?.location;
    if(wp) return {lng: wp[0], lat: wp[1]};
    return {lng: dest.lng, lat: dest.lat};
  }

  // Walk intersections accumulating distance; prefer intersections that stay in the intended bearing cone
  let best = ints[ints.length-1];
  let bestDiff = Infinity;
  let cum = 0;

  const cone = 70; // degrees around the intended bearing
  const want = bearingDeg;

  // first pass: strict cone
  for(let pass=0; pass<2; pass++){
    best = ints[ints.length-1];
    bestDiff = Infinity;
    cum = 0;

    for(let i=1;i<ints.length;i++){
      const prev = ints[i-1], cur = ints[i];
      cum += haversineM(prev.lat, prev.lng, cur.lat, cur.lng);
      if(cum < Math.min(120, targetMeters*0.25)) continue;

      const br = bearingDeg(incident.lat, incident.lng, cur.lat, cur.lng);
      const okCone = angDiff(br, want) <= (pass===0 ? cone : 140); // relax on 2nd pass

      if(!okCone) continue;

      const diff = Math.abs(cum - targetMeters);
      if(diff < bestDiff){
        bestDiff = diff;
        best = cur;
      }
    }
    if(bestDiff < Infinity) break;
  }
  return best;
}

function biasFactorForCardinal(card){
  // card: "N","E","S","W"
  if(direction==="unknown") return 1.0;
  if(card===direction) return 1.35;
  const opp = (d)=> (d==="N"?"S":d==="S"?"N":d==="E"?"W":"E");
  if(card===opp(direction)) return 0.85;
  return 1.0;
}

async function buildOutwardPoints(){
  const base = baseMeters();
  const shrinkTries = [1.0, 0.85, 0.70, 0.55];
  for(const shrink of shrinkTries){
    const t = base * shrink;
    const cards = [
      {name:"1", corner:"N", card:"N", bearing:0},
      {name:"2", corner:"E", card:"E", bearing:90},
      {name:"3", corner:"S", card:"S", bearing:180},
      {name:"4", corner:"W", card:"W", bearing:270},
    ];
    const pts=[];
    for(const c of cards){
      const bf = biasFactorForCardinal(c.card);
      const p = await routeOutwardPoint(c.bearing, t*bf);
      pts.push({name:c.name, corner:c.corner, lat:p.lat, lng:p.lng});
    }
    return {points: pts, shrinkUsed: shrink};
  }
  return {points: [], shrinkUsed: 1.0};
}

async function fetchJsonRetry(url, tries=3){
  let lastErr=null;
  for(let i=0;i<tries;i++){
    try{
      const res = await fetch(url);
      if(res.ok) return await res.json();
      const t = await res.text().catch(()=>"");
      lastErr = new Error(`HTTP ${res.status} ${t.slice(0,140)}`);
      // Retry on rate limits / transient errors
      if([408,429,500,502,503,504].includes(res.status)){
        await new Promise(r=>setTimeout(r, 400*(i+1)));
        continue;
      }
      throw lastErr;
    }catch(e){
      lastErr=e;
      await new Promise(r=>setTimeout(r, 300*(i+1)));
    }
  }
  throw lastErr || new Error('request failed');
}


// Get nearest road names via Tilequery (better for intersection labels than reverse geocode)
async function mbRoadNamesAt(lng,lat){
  const token = getToken();
  const radius = 35; // meters
  const limit = 25;
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lng},${lat}.json?layers=road&radius=${radius}&limit=${limit}&access_token=${encodeURIComponent(token)}`;
  const data = await fetchJsonRetry(url, 2);
  const feats = data.features || [];
  // gather distinct road names, prefer higher relevance (closer features usually first)
  const names=[];
  for(const f of feats){
    const p = f.properties || {};
    const n = (p.name || p.ref || "").toString().trim();
    if(!n) continue;
    if(!names.includes(n)) names.push(n);
    if(names.length>=4) break;
  }
  return names;
}
function fmtIntersectionFromRoads(roads){
  const r=(roads||[]).map(x=>String(x||"").trim()).filter(Boolean);
  if(r.length>=2) return `${r[0]} & ${r[1]}`;
  if(r.length===1) return r[0];
  return "";
}
// Mapbox: geocoding
async function mbGeocode(query){
  const token = getToken();
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${encodeURIComponent(token)}&autocomplete=true&limit=1`;
  const res = await fetch(url);
  if(!res.ok) throw new Error("geocode");
  const data = await res.json();
  const f = data.features?.[0];
  if(!f?.center) throw new Error("no result");
  return {lng:f.center[0], lat:f.center[1], place: f.place_name || query};
}
async function mbReverse(lng,lat){
  const token = getToken();
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${encodeURIComponent(token)}&types=address,poi&limit=1`;
  const res = await fetch(url);
  if(!res.ok) return "";
  const data = await res.json();
  const f = data.features?.[0];
  return (f?.text || f?.place_name || "").toString();
}
function shortLabel(txt){
  // Mapbox place_name can be long; keep first chunk or intersection-like input
  if(!txt) return "Incident";
  const parts = txt.split(",").map(s=>s.trim()).filter(Boolean);
  return parts[0] || txt;
}

// Snap a candidate point to the *routable* network using Mapbox Directions waypoints.
// This prevents points landing in canals/medians/off-road.
async function snapToRoutable(lat,lng){
  const token = getToken();
  const profile = (method==="vehicle") ? "driving" : "walking";
  // Directions returns snapped waypoints for both origin and destination
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${incident.lng},${incident.lat};${lng},${lat}?access_token=${encodeURIComponent(token)}&overview=false&steps=false&alternatives=false&geometries=geojson`;
  const data = await fetchJsonRetry(url, 3);
  const wp = data.waypoints;
  const route = data.routes?.[0];
  if(!wp?.length || !route) throw new Error("no route");
  // snapped destination is waypoint[1].location = [lng,lat]
  const snapped = wp[1]?.location;
  if(!snapped) throw new Error("no snapped");
  return {
    lat: snapped[1],
    lng: snapped[0],
    distance_m: route.distance || null,
    duration_s: route.duration || null
  };
}

// From an arbitrary routable point, walk a very short route and take the last intersection along it.
async function snapToNearestIntersection(lat,lng){
  const token = getToken();
  const profile = profileForMethod ? profileForMethod() : ((method==="vehicle") ? "driving" : "walking");
  // Route from incident to point, but ask for steps so we can pick the last intersection
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${incident.lng},${incident.lat};${lng},${lat}` +
              `?access_token=${encodeURIComponent(token)}&overview=false&steps=true&alternatives=false&geometries=geojson`;
  const data = await fetchJsonRetry(url, 2);
  const ints = extractIntersections(data);
  if(ints.length) return ints[ints.length-1];
  const wp = data.waypoints?.[1]?.location;
  if(wp) return {lng: wp[0], lat: wp[1]};
  return {lng,lat};
}

// Mapbox GL map
let map=null;
let incidentMarker=null;
let dragMarkers=[];

let sourcesReady=false;
let perimeterIds = {source:"perimetr-perimeter", layerFill:"perimetr-fill", layerLine:"perimetr-line"};
let pointsIds = {source:"perimetr-points", layer:"perimetr-points-layer"};
let using3d=false;

function styleUrl(){
  return mapStyle==="satellite" ? "mapbox://styles/mapbox/satellite-streets-v12" : "mapbox://styles/mapbox/streets-v12";
}

function ensureMap(){
  const token = getToken();
  if(!token){ alert("Paste a Mapbox token on the login screen first."); return; }
  mapboxgl.accessToken = token;

  if(map) return;

  map = new mapboxgl.Map({
    container: "map",
    style: styleUrl(),
    center: [-80.303, 25.986],
    zoom: 14,
    pitch: 55,
    bearing: 0,
    antialias: true
  });

  map.addControl(new mapboxgl.NavigationControl({visualizePitch:true}), "top-right");

  map.on("load", ()=>{
    sourcesReady=false;
    // perimeter source/layers
    map.addSource(perimeterIds.source, { type:"geojson", data: {type:"FeatureCollection", features: []} });
    map.addLayer({ id: perimeterIds.layerFill, type:"fill", source: perimeterIds.source,
      paint: {"fill-color":"#3b82f6","fill-opacity":0.18} });
    map.addLayer({ id: perimeterIds.layerLine, type:"line", source: perimeterIds.source,
      paint: {"line-color":"#3b82f6","line-width":2} });

    // points source/layer
    map.addSource(pointsIds.source, { type:"geojson", data: {type:"FeatureCollection", features: []} });
    map.addLayer({ id: pointsIds.layer, type:"circle", source: pointsIds.source,
  paint: {"circle-radius":8,"circle-color":["match",["get","status"],"covered","#22c55e","enroute","#f59e0b","#ffffff"],"circle-stroke-color":"#2563eb","circle-stroke-width":2}
});

    add3dBuildings();
    sourcesReady=true;
  });

  map.on("click", async (e)=>{
    if(!e?.lngLat) return;
    await setIncident(e.lngLat.lat, e.lngLat.lng, "Tap");
    if(pickMode){
      pickMode=false;
      $("pickHint").style.display="none";
      go("Setup");
    }
  });
}

function add3dBuildings(){
  // Try to add 3D buildings for styles that include "composite"
  try{
    const layers = map.getStyle().layers || [];
    const labelLayerId = layers.find(l => l.type === "symbol" && l.layout && l.layout["text-field"])?.id;

    map.addLayer({
      id: "3d-buildings",
      source: "composite",
      "source-layer": "building",
      filter: ["==", "extrude", "true"],
      type: "fill-extrusion",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": "#aaa",
        "fill-extrusion-height": ["get", "height"],
        "fill-extrusion-base": ["get", "min_height"],
        "fill-extrusion-opacity": 0.75
      }
    }, labelLayerId);
    using3d=true;
  }catch{
    using3d=false;
  }
}

function applyStyle(){
  if(!map) return;
  const s = styleUrl();
  map.setStyle(s);
  map.once("styledata", ()=>{
    // style reset; re-add layers/sources
    map.once("load", ()=>{
      // handled by ensureMap load only at init; for setStyle, re-run setup:
    });
  });
  map.once("style.load", ()=>{
    // Re-create sources/layers
    try{
      map.addSource(perimeterIds.source, { type:"geojson", data: {type:"FeatureCollection", features: []} });
      map.addLayer({ id: perimeterIds.layerFill, type:"fill", source: perimeterIds.source, paint: {"fill-color":"#3b82f6","fill-opacity":0.18} });
      map.addLayer({ id: perimeterIds.layerLine, type:"line", source: perimeterIds.source, paint: {"line-color":"#3b82f6","line-width":2} });

      map.addSource(pointsIds.source, { type:"geojson", data: {type:"FeatureCollection", features: []} });
      map.addLayer({ id: pointsIds.layer, type:"circle", source: pointsIds.source,
  paint: {"circle-radius":8,"circle-color":["match",["get","status"],"covered","#22c55e","enroute","#f59e0b","#ffffff"],"circle-stroke-color":"#2563eb","circle-stroke-width":2}
});

      add3dBuildings();
      sourcesReady=true;
      if(incident){ setMarker(incident.lat, incident.lng); }
    }catch{}
  });
}

function setMarker(lat,lng){
  if(!map) return;
  if(!incidentMarker){
    incidentMarker = new mapboxgl.Marker({color:"#ef4444"}).setLngLat([lng,lat]).addTo(map);
  }else{
    incidentMarker.setLngLat([lng,lat]);
  }
}

async function setIncidentNoMap(lat,lng){
  incident = { lat, lng, label: 'Incident' };
  $('addrHelp').textContent = 'Selected: Current location';
  const mt=$('mapTitle'); if(mt) mt.textContent = 'Incident: Current location';
}

async function setIncident(lat,lng,why){
  // Only create the map when we actually need to show it (Map screen or pick mode)
  if(!map && (screens.Map?.classList.contains('active') || pickMode)) ensureMap();
  if(map) { /* map available */ }
  const labelRaw = await mbReverse(lng,lat).catch(()=> "");
  incident = { lat, lng, label: shortLabel(labelRaw) || "Incident" };
  // Try to display as an intersection label when possible
  try{
    const roads = await mbRoadNamesAt(lng, lat);
    const inter = fmtIntersectionFromRoads(roads);
    if(inter) incident.label = inter;
  }catch{}
  $("addrHelp").textContent = `Selected: ${incident.label}`;
  $("mapTitle").textContent = `Incident: ${incident.label}`;
  setMarker(lat,lng);
  if(map) map.easeTo({center:[lng,lat], zoom: Math.max(map.getZoom(), 15), pitch:55, bearing: (direction==="unknown"?0:map.getBearing())});
}

// Address search -> Mapbox geocode
$("btnSearch").onclick = async ()=>{
  const q = ($("addr").value||"").trim();
  if(!q) return alert("Enter an address or intersection.");
  $("addrHelp").textContent = "Searching…";
  try{
    const g = await mbGeocode(q);
    await setIncident(g.lat, g.lng, "Search");
    $("addrHelp").textContent = `Found: ${shortLabel(g.place)}`;
  }catch{
    $("addrHelp").textContent = "Search failed. Check token or query.";
    alert("Search failed. Verify your Mapbox token and try a more specific query.");
  }
};

// GPS
$("btnGps").onclick = ()=>{
  if(!navigator.geolocation){ setGpsStatus("denied"); return alert("Geolocation not supported."); }
  navigator.geolocation.getCurrentPosition(
    async (pos)=>{
      setGpsStatus("ok");
      // Set incident immediately even if map is not yet visible
      await setIncidentNoMap(pos.coords.latitude, pos.coords.longitude);
      // Try to resolve a nicer label (non-blocking)
      try{
        const txt = await mbReverse(pos.coords.longitude, pos.coords.latitude);
        incident.label = shortLabel(txt) || "Current location";
        $("addrHelp").textContent = `Selected: ${incident.label}`;
      }catch{}
    },
    ()=>{ setGpsStatus("denied"); alert("GPS denied/unavailable. iOS: Settings → Privacy & Security → Location Services → Safari Website."); },
    {enableHighAccuracy:true, timeout:12000, maximumAge:60000}
  );
};


// Perimeter draw
function clearDragMarkers(){ dragMarkers.forEach(m=>{try{m.remove()}catch{}}); dragMarkers=[]; }

function setGeojson(id, data){
  if(!map || !sourcesReady) return;
  const src = map.getSource(id);
  if(src) src.setData(data);
}

async function labelPoint(p){
  // Prefer road-road labels (intersection-style)
  try{
    const roads = await mbRoadNamesAt(p.lng, p.lat);
    const inter = fmtIntersectionFromRoads(roads);
    if(inter) return inter;
  }catch{}
  // Fallback
  const txt = await mbReverse(p.lng, p.lat).catch(()=>"");
  return shortLabel(txt) || `${p.corner}`;
}

function pointsGeo(pts){
  return {
    type:"FeatureCollection",
    features: pts.map(p=>({
      type:"Feature",
      properties:{name:p.name, corner:p.corner, label:p.label||""},
      geometry:{type:"Point", coordinates:[p.lng, p.lat]}
    }))
  };
}
function rebuildPerimeterLayers(pts){ setGeojson(perimeterIds.source, polyGeo(pts)); setGeojson(pointsIds.source, pointsGeo(pts)); }

function polyGeo(pts){
  const ring = pts.map(p=>[p.lng,p.lat]);
  ring.push([pts[0].lng, pts[0].lat]);
  return { type:"FeatureCollection", features:[{type:"Feature", properties:{}, geometry:{type:"Polygon", coordinates:[ring]}}] };
}

function cycleStatus(s){return s==='unassigned'?'enroute':(s==='enroute'?'covered':'unassigned');}
function statusBadge(s){
 if(s==='covered') return '<span class="badge green">Covered</span>';
 if(s==='enroute') return '<span class="badge" style="border-color:rgba(245,158,11,.55);background:rgba(245,158,11,.14)">En route</span>';
 return '<span class="badge">—</span>';
}
function renderPointKPIs(pts){
 const k=$('kpis'); k.innerHTML='';
 pts.forEach((p,i)=>{
  const div=document.createElement('div'); div.className='kpi';
  div.innerHTML=`<div class="k">Point ${p.name} • ${p.corner} ${statusBadge(p.status||'unassigned')}</div>`+
   `<div class="v"><b>${p.label||p.corner}</b><div class="smallnote">Drag to adjust • Tap card to cycle status</div></div>`;
  div.onclick=()=>{
    const cur=pointStates[i]?.status||'unassigned';
    const nxt=cycleStatus(cur);
    pointStates[i]={status:nxt};
    p.status=nxt;
    const mk=dragMarkers[i];
    if(mk?.getElement){ const el=mk.getElement(); el.style.background=(nxt==='covered')?'#22c55e':(nxt==='enroute'?'#f59e0b':'#ffffff'); }
    rebuildPerimeterLayers(pts);
    renderPointKPIs(pts);
  };
  k.appendChild(div);
 });
}

async function drawPerimeter(){
  // Only create the map when we actually need to show it (Map screen or pick mode)
  if(!map && (screens.Map?.classList.contains('active') || pickMode)) ensureMap();
  if(map) { /* map available */ }
  if(!incident) return alert("Set a location first (GPS, search, or tap map).");

  $("timerText").textContent = `Timer: ${String(minutes).padStart(2,"0")}:00`;
  $("methodText").textContent = `Method: ${method[0].toUpperCase()+method.slice(1)} • Dir: ${direction==="unknown"?"—":direction}`;
  $("mapTitle").textContent = `Active Perimeter • ${incident.label}`;
  pickMode=false; $("pickHint").style.display="none";

  $("kpis").innerHTML = `<div class="kpi"><div class="k">Generating… <span class="badge blue">3D map</span> <span class="badge green">road-snapped</span></div><div class="v">Routing to 4 accessible intersections.</div></div>`;

  // Build 4 points by routing outward (accessible intersections)
  let resPts=null, shrinkUsed=1.0;
  try{
    const built = await buildOutwardPoints();
    resPts = built.points;
    shrinkUsed = built.shrinkUsed;
    // label them after we have routable points
    for(const p of resPts){ p.label = await labelPoint(p); }
  
  }catch(e){
    console.error(e);
    // Fallback: build a box and snap each corner to routable network
    try{
      const corners = computeCorners(incident.lat, incident.lng, 0.7);
      for(const p of corners){
        try{
          const sn = await snapToRoutable(p.lat, p.lng);
          p.lat = sn.lat; p.lng = sn.lng;
          try{
            const it = await snapToNearestIntersection(p.lat, p.lng);
            p.lat = it.lat; p.lng = it.lng;
          }catch{}
        }catch{}
        p.label = await labelPoint(p);
      }
      resPts = corners;
      shrinkUsed = 0.7;
    }catch(e2){
      alert("Routing failed. This can happen if your Mapbox token is restricted, you’re rate-limited, or network is blocked.");
      return;
    }
  }



  // Ensure polygon wraps around incident
  resPts = sortByAngleAroundIncident(resPts);

  // If incident ends up outside (road network quirks), retry using diagonal bearings to better surround
  const ring0 = resPts.map(p=>[p.lng,p.lat]);
  if(!pointInPoly(incident.lng, incident.lat, ring0)){
    console.warn("Incident outside polygon; retrying diagonal bearings");
    async function buildDiagonal(){
      const base = baseMeters();
      const t = base * 0.9;
      const diags = [
        {name:"1", corner:"NW", card:"N", bearing:315},
        {name:"2", corner:"NE", card:"E", bearing:45},
        {name:"3", corner:"SE", card:"S", bearing:135},
        {name:"4", corner:"SW", card:"W", bearing:225},
      ];
      const pts=[];
      for(const c of diags){
        const bf = biasFactorForCardinal(c.card);
        const p = await routeOutwardPoint(c.bearing, t*bf);
        pts.push({name:c.name, corner:c.corner, lat:p.lat, lng:p.lng});
      }
      for(const p of pts){ p.label = await labelPoint(p); }
      return sortByAngleAroundIncident(pts);
    }
    try{
      resPts = await buildDiagonal();
      shrinkUsed = 0.9;
    }catch{}
  }

    // Attach current point status
  resPts.forEach((p,i)=>{ p.status = (pointStates[i]?.status||'unassigned'); });

// Update map layers
  setGeojson(perimeterIds.source, polyGeo(resPts));
  setGeojson(pointsIds.source, pointsGeo(resPts));

  // Draggable point adjustment (manual override)
  clearDragMarkers();
  resPts.forEach((p, idx)=>{
    const el=document.createElement("div");
    el.style.width="18px"; el.style.height="18px"; el.style.borderRadius="999px";
    el.style.background=(p.status==="covered")?"#22c55e":(p.status==="enroute"?"#f59e0b":"#ffffff");
    el.style.border="2px solid #2563eb"; el.style.boxShadow="0 8px 18px rgba(0,0,0,.35)";
    const mk=new mapboxgl.Marker({element:el, draggable:true}).setLngLat([p.lng,p.lat]).addTo(map);

    mk.on("dragstart", ()=>{ $("mapTitle").textContent = `Adjusting Point ${p.name}`; });

    mk.on("dragend", async ()=>{
      const ll=mk.getLngLat();
      // snap dragged point to nearest intersection
      try{
        const sn = await snapToNearestIntersection(ll.lat, ll.lng);
        p.lat = sn.lat; p.lng = sn.lng;
        mk.setLngLat([p.lng,p.lat]);
      }catch{
        p.lat = ll.lat; p.lng = ll.lng;
      }
      // name as intersection
      try{ p.label = await labelPoint(p); }catch{}
      // keep status
      p.status = pointStates[idx]?.status || "unassigned";
      rebuildPerimeterLayers(resPts);
      renderPointKPIs(resPts);
    });

    dragMarkers.push(mk);
  });

  // Fit bounds
  const bounds = new mapboxgl.LngLatBounds();
  resPts.forEach(p=>bounds.extend([p.lng,p.lat]));
  bounds.extend([incident.lng, incident.lat]);
  map.fitBounds(bounds, {padding: 40, maxZoom: 16, pitch: 55});

  // KPIs
    renderPointKPIs(resPts);
  if(shrinkUsed<1.0){
    const n=document.createElement('div'); n.className='smallnote';
    n.textContent = `Note: reduced for fit (shrink ${shrinkUsed}).`;
    $('kpis').appendChild(n);
  }
}

$("btnGenerate").onclick = async ()=>{
  if(!incident){
    // If user typed something but didn't press Search
    const q = ($("addr").value||"").trim();
    if(q){
      try{
        const g = await mbGeocode(q);
        await setIncident(g.lat, g.lng, "Search");
      }catch{
        return alert("Could not resolve address. Press SEARCH after entering a clearer location.");
      }
    }else{
      return alert("Set a location first (GPS, search, or tap map).");
    }
  }

  resetPointStates();
  loadIncidents();
  incidents.unshift({lat:incident.lat,lng:incident.lng,label:incident.label,minutes,method,direction,updates:[]});
  saveIncidents();

  updates=[];
  $("updMinSlider").value=minutes; $("updMinLabel").textContent=minutes;
  setUpdMethod(method); setUpdDir(direction); syncUpdatesUI();

  go("Map");
  await drawPerimeter();
};

// Incidents list
function renderIncidentList(){
  loadIncidents();
  const el = $("incidentList");
  if(!incidents.length){ el.textContent="No incidents yet."; return; }
  el.innerHTML="";
  incidents.forEach((inc)=>{
    const div=document.createElement("div");
    div.className="item";
    div.innerHTML = `<div class="t">${inc.label}</div><div class="s">${inc.minutes} min • ${inc.method} • Dir: ${inc.direction==="unknown"?"—":inc.direction}</div>`;
    div.onclick = async ()=>{
      minutes=inc.minutes; method=inc.method; direction=inc.direction||"unknown";
      $("minSlider").value=minutes; $("minLabel").textContent=minutes;
      document.querySelectorAll("#methodGrid .chip").forEach(x=>x.classList.toggle("active", x.dataset.method===method));
      document.querySelectorAll("#dirGrid .chip").forEach(x=>x.classList.toggle("active", x.dataset.dir===direction));
      incident={lat:inc.lat,lng:inc.lng,label:inc.label};
      updates=inc.updates||[]; syncUpdatesUI();
      ensureMap();
      setMarker(incident.lat, incident.lng);
      go("Map");
      await drawPerimeter();
    };
    el.appendChild(div);
  });
}

// Updates UI
$("updMinSlider").oninput = (e)=> $("updMinLabel").textContent = e.target.value;
function setUpdMethod(m){ document.querySelectorAll("#updMethod .chip").forEach(x=>x.classList.toggle("active", x.dataset.um===m)); }
function setUpdDir(d){ document.querySelectorAll("#updDir .chip").forEach(x=>x.classList.toggle("active", x.dataset.ud===d)); }
document.querySelectorAll("#updMethod .chip").forEach(c=>c.onclick=()=>setUpdMethod(c.dataset.um));
document.querySelectorAll("#updDir .chip").forEach(c=>c.onclick=()=>setUpdDir(c.dataset.ud));
function activeUpdMethod(){ return document.querySelector("#updMethod .chip.active")?.dataset.um || method; }
function activeUpdDir(){ return document.querySelector("#updDir .chip.active")?.dataset.ud || direction; }
function stamp(){ const d=new Date(); return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}); }
function syncUpdatesUI(){
  const log=$("updatesLog"); log.innerHTML="";
  if(!updates.length){ const e=document.createElement("div"); e.className="smallnote"; e.textContent="No updates yet."; log.appendChild(e); return; }
  updates.forEach(u=>{
    const div=document.createElement("div");
    div.className="item";
    div.innerHTML = `<div class="t">${u.time} • ${u.minutes} min • ${u.method} • Dir: ${u.direction==="unknown"?"—":u.direction}</div><div class="s">${u.note||""}</div>`;
    log.appendChild(div);
  });
}
$("btnApplyUpdate").onclick = async ()=>{
  if(!incident) return;
  minutes = Number($("updMinSlider").value);
  method = activeUpdMethod();
  direction = activeUpdDir();
  $("minSlider").value=minutes; $("minLabel").textContent=minutes;

  const entry = { time: stamp(), minutes, method, direction, note: ($("updateNote").value||"").trim() };
  $("updateNote").value="";
  updates.unshift(entry);
  syncUpdatesUI();

  loadIncidents();
  if(incidents.length){ incidents[0].minutes=minutes; incidents[0].method=method; incidents[0].direction=direction; incidents[0].updates=updates; saveIncidents(); }
  await drawPerimeter();
};
$("btnClearUpdates").onclick = ()=>{
  updates=[]; syncUpdatesUI();
  loadIncidents();
  if(incidents.length){ incidents[0].updates=[]; saveIncidents(); }
};
$("btnRecenter").onclick = ()=>{ if(map && incident){ map.easeTo({center:[incident.lng,incident.lat], zoom: 16, pitch:55}); } };

// Login/Logout
$("btnLogin").onclick = ()=>{
  const dept = ($("loginDept").value||"").trim();
  const id = ($("loginId").value||"").trim();
  const pin = ($("loginPin").value||"").trim();
  if(!dept||!id||!pin) return alert("Enter dept, ID, and PIN.");
  if(pin!=="1234") return alert("Demo PIN is 1234.");
  if(!getToken()) return alert("Paste and save a Mapbox token first (needed for 3D map).");
  session = {dept,id}; saveSession();
  $("whoami").textContent = `${session.dept} • ID ${session.id}`;
  seedDemoIncidentsIfEmpty().finally(()=>{ loadIncidents(); });
  go("Home");
};
// Seed demo incidents (Miramar) if empty
async function seedDemoIncidentsIfEmpty(){
  loadIncidents();
  if(incidents.length) return;
  const seeds = [
    { q: "Miramar Parkway & Flamingo Road, Miramar, FL", minutes: 4, method: "foot", direction: "unknown" },
    { q: "Miramar Parkway & S University Dr, Miramar, FL", minutes: 8, method: "vehicle", direction: "E" },
    { q: "Miramar Parkway & SW 64th Ave, Miramar, FL", minutes: 6, method: "foot", direction: "N" },
    { q: "SW 68th Ave & SW 34th St, Miramar, FL", minutes: 10, method: "vehicle", direction: "W" }
  ];
  const delay=(ms)=>new Promise(r=>setTimeout(r,ms));
  for(const s of seeds){
    try{
      minutes=s.minutes; method=s.method; direction=s.direction;
      const g = await mbGeocode(s.q);
      const lbl = shortLabel(g.place);
      incidents.push({lat:g.lat,lng:g.lng,label:lbl,minutes:s.minutes,method:s.method,direction:s.direction,updates:[]});
      await delay(250);
    }catch{}
  }
  saveIncidents();
}

// Boot
setGpsStatus("idle");
// SW disabled for tap stability
)); }
if(session){
  $("whoami").textContent = `${session.dept} • ID ${session.id}`;
  go("Home");
}else{
  go("Login");
}


document.addEventListener("DOMContentLoaded", ()=>{
  // Login screen
  bindTap("btnSaveToken", ()=>{
    const t = ($("token")?.value || "").trim();
    if(!t) return alert("Paste a Mapbox public token (pk.…) and tap Save.");
    localStorage.setItem("mb_token", t);
    alert("Token saved on this device.");
  });

  bindTap("btnLogin", ()=>{
    const u = ($("user")?.value || "").trim();
    const p = ($("pass")?.value || "").trim();
    if(!u || !p) return alert("Enter demo credentials.");
    localStorage.setItem("session_user", u);
    go("Home");
  });

  // Home / Map actions
  bindTap("btnNew", ()=>{
    resetPointStates?.();
    incident = null;
    updates = [];
    try{ $("addr").value=""; }catch{}
    go("Setup");
  });

  bindTap("btnNew2", ()=>{
    resetPointStates?.();
    incident = null;
    updates = [];
    pickMode=false;
    try{ $("pickHint").style.display="none"; }catch{}
    go("Setup");
  });

  bindTap("btnActive", ()=>{
    renderIncidentList?.();
    go("Incidents");
  });

  bindTap("btnBackHome", ()=>go("Home"));
  bindTap("btnBackHome2", ()=>go("Home"));

  bindTap("btnLogout", ()=>{
    resetPointStates?.();
    incident = null;
    updates = [];
    clearSession?.();
    go("Login");
  });
});

