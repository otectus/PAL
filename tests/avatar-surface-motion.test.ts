import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import sharp from 'sharp';
import { avatarCatalog } from '../broker/avatars.ts';

const director = vm.createContext({});
vm.runInContext(readFileSync('qml/SurfaceMotion.js', 'utf8').replace(/^\.pragma library\s*/, ''), director);
const catalog = {
  routes: { wave: { frames: [0, 1, 2, 3], frameMs: 20, holdMs: 40 }, think: { frames: [0, 4, 5, 6], frameMs: 20, holdMs: 40 }, open: { frames: [0, 7, 8, 9], frameMs: 20, holdMs: 40 } },
  motions: { wave: 'wave', thinking: 'think', explainOpen: 'open' }
};
const tick = (state: any, seconds = .02) => director.sample(state, seconds, true);

function upperHeadColor(pixels: Buffer, stride: number, left: number, top: number, width: number, height: number) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const i = ((top + y) * stride + left + x) * 4;
      if (pixels[i + 3] < 200) continue;
      for (let c = 0; c < 3; c++) sum[c] += pixels[i + c];
      count++;
    }
  }
  assert.ok(count > 0, 'visible artwork above the eyes');
  return sum.map(value => value / count);
}

test('new and repaired portrait cells have transparent gutters without neighboring-row fragments', async () => {
  for(const id of ['pal','pal_classic','pal_gothic','pal_punk','pal_punk_unmasked','nova','soap']){
    const {data,info}=await sharp(`assets/${id}-portraits.png`).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.deepEqual([info.width,info.height],[1024,768],id);
    for(let cell=0;cell<12;cell++){
      const left=cell%4*256,top=Math.floor(cell/4)*256;
      let painted=0;
      for(let y=0;y<256;y++)for(let x=0;x<256;x++){
        const alpha=data[((top+y)*info.width+left+x)*4+3];
        if(x<8||y<8||x>=248||y>=248)assert.equal(alpha,0,`${id}/${cell}: clear cell gutter`);
        if(alpha>180)painted++;
      }
      assert.ok(painted>5000,`${id}/${cell}: portrait remains visible`);
    }
  }
});

test('portrait expressions preserve the neutral silhouette, hair and costume outside the face', async () => {
  for(const {id,portrait,authoring} of avatarCatalog){
    const rig = JSON.parse(readFileSync(`assets/${avatarCatalog.find(entry => entry.id === id)!.rig}`, 'utf8'));
    const {data,info}=await sharp(`assets/${portrait}`).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const neutral=Buffer.alloc(256*256*4);
    for(let y=0;y<256;y++)data.copy(neutral,y*256*4,(y*info.width)*4,(y*info.width+256)*4);
    // The preparation mask is deliberately generous enough for surprise and
    // closed eyes; the outer corners still cover hair, shoulders and costume.
    const {cx,cy,rx,ry}=authoring.portraitFace || {cx:128,cy:120,rx:100,ry:95};
    for(let cell=1;cell<12;cell++){
      let changed=0;
      for(let y=0;y<256;y++)for(let x=0;x<256;x++){
        const a=(y*256+x)*4,b=((Math.floor(cell/4)*256+y)*info.width+(cell%4)*256+x)*4;
        if(data[b+3]!==neutral[a+3])assert.fail(`${id}/${cell}: silhouette changed at ${x},${y}`);
        if(data.readUInt32LE(b)===neutral.readUInt32LE(a))continue;
        if(Math.hypot((x-cx)/rx,(y-cy)/ry)>=1)assert.fail(`${id}/${cell}: outer artwork changed at ${x},${y}`);
        if(data[b+3]>200 && Math.max(...[0,1,2].map(c=>Math.abs(data[b+c]-neutral[a+c])))>15)changed++;
      }
      if (rig.static) assert.equal(changed, 0, `${id}/${cell}: static reference keeps its neutral expression`);
      else assert.ok(changed>100,`${id}/${cell}: expression must remain visible`);
    }
  }
});

test('new neutral artwork preserves reference colors and blinks only registered visible eyes', async t => {
  const sources = Object.fromEntries(avatarCatalog.map(entry => [entry.id, entry.authoring]));
  for (const id of ['pal', 'pal_classic', 'pal_gothic', 'pal_punk_unmasked', 'cynthia', 'genga', 'kippy', 'pomni', 'rem', 'sarah', 'sylva', 'witty']) {
    const directory = 'artwork/avatars/' + id;
    const referencePath = id === 'pal' ? 'reference/pal-front.png' : 'reference/' + id + '.png';
    await t.test(id, {skip: !existsSync(directory + '/front.png') || !existsSync(referencePath)}, async () => {
      const cfg = sources[id];
      const [left, top, width, height] = cfg.crop;
      const referenceImage = sharp(referencePath).extract({left, top, width, height});
      const {data: reference, info: referenceInfo} = await referenceImage.ensureAlpha().raw().toBuffer({resolveWithObject: true});
      const {data: open, info: openInfo} = await sharp(directory + '/front.png').ensureAlpha().raw().toBuffer({resolveWithObject: true});
      const {data: closed, info: closedInfo} = await sharp(directory + '/blink.png').ensureAlpha().raw().toBuffer({resolveWithObject: true});
      const registration = JSON.parse(readFileSync(directory + '/registration.json', 'utf8'));
      assert.deepEqual([openInfo.width, openInfo.height], [referenceInfo.width, referenceInfo.height], id + ': neutral dimensions');
      assert.deepEqual([closedInfo.width, closedInfo.height], [openInfo.width, openInfo.height], id + ': blink dimensions');
      assert.equal(registration.targets.length, cfg.eyes.length);
      if (id === 'rem') assert.equal(cfg.eyes.length, 1, 'the fringe-covered eye is never invented or repainted');
      if (id === 'witty') assert.equal(cfg.eyes.length, 1, 'the mint X is a fixed mark, only the visible eye blinks');
      let changes = 0;
      for (let y = 0; y < openInfo.height; y++) for (let x = 0; x < openInfo.width; x++) {
        const at = (y * openInfo.width + x) * 4;
        assert.equal(open[at + 3], closed[at + 3], id + ': blinking preserves the silhouette');
        if (open[at + 3]) assert.deepEqual(open.subarray(at, at + 3), reference.subarray(at, at + 3), id + ': original RGB');
        if ([0, 1, 2].some(c => open[at + c] !== closed[at + c])) {
          const sourceX = x + left, sourceY = y + top;
          assert.ok(cfg.eyes.some(([ex, ey, ew, eh]: number[]) => sourceX >= ex && sourceX < ex + ew && sourceY >= ey && sourceY < ey + eh), id + ': changes stay inside visible eyelids');
          changes++;
        }
      }
      assert.ok(changes > 100, id + ': eyelids actually close');
    });
  }
});

test('default PAL cups both lower cheeks in the gentle and strong shy holds, including blinks', async () => {
  const avatar = avatarCatalog.find(entry => entry.id === 'pal')!;
  assert.equal(avatar.default, true);
  const rig = JSON.parse(readFileSync(`assets/${avatar.rig}`, 'utf8'));
  const part = rig.parts[0], shy = rig.surfaceSequences.routes.shy;
  const {data, info} = await sharp(`assets/${rig.texture}`).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const [nx, ny, nw, nh] = part.sourceRect;
  const neutral = await sharp(data, {raw:info}).extract({left:nx, top:ny, width:nw, height:nh})
    .resize(400, 400).ensureAlpha().raw().toBuffer();
  // The authored fingertip targets are x=345..380/y=270..320 in the
  // 1024-square neutral coordinate system. These slightly generous 400px
  // regions stay beside and below the eyes while covering the lower visor
  // edges. Head tilt can move the pale shell through them, but only graphite
  // fingers add enough neutral-gray pixels over the neutral dark face on both
  // sides. Requiring the same pixels in the open and blink cells prevents an
  // eyelid repaint from masquerading as cheek contact.
  const cheeks = [
    {name:'viewer-left', left:132, top:103, width:24, height:32},
    {name:'viewer-right', left:244, top:103, width:24, height:32},
  ];
  const contactPixels = (openRect:number[], blinkRect:number[], cheek:typeof cheeks[number]) => {
    let count = 0;
    for (let y = cheek.top; y < cheek.top + cheek.height; y++) for (let x = cheek.left; x < cheek.left + cheek.width; x++) {
      const neutralAt = (y * 400 + x) * 4;
      const openAt = ((openRect[1] + y) * info.width + openRect[0] + x) * 4;
      const blinkAt = ((blinkRect[1] + y) * info.width + blinkRect[0] + x) * 4;
      const neutralLight = (neutral[neutralAt] + neutral[neutralAt + 1] + neutral[neutralAt + 2]) / 3;
      const rgb = [data[openAt], data[openAt + 1], data[openAt + 2]];
      const light = (rgb[0] + rgb[1] + rgb[2]) / 3;
      if (neutral[neutralAt + 3] > 200 && neutralLight < 35
          && data[openAt + 3] > 200 && Math.max(...rgb) - Math.min(...rgb) < 20
          && light >= 35 && light <= 140
          && data.readUInt32LE(openAt) === data.readUInt32LE(blinkAt)) count++;
    }
    return count;
  };
  for (const index of [24, 51]) {
    const id = shy.frames[index], frame = part.surfaceFrames[id - 1];
    assert.deepEqual(frame.sourceRect.slice(2), [400, 400], `pal/shy-${index}: open hold dimensions`);
    assert.deepEqual(frame.blinkSourceRect.slice(2), [400, 400], `pal/shy-${index}: blink hold dimensions`);
    for (const cheek of cheeks) {
      const count = contactPixels(frame.sourceRect, frame.blinkSourceRect, cheek);
      assert.ok(count >= 80, `pal/shy-${index}/${cheek.name}: ${count} stable graphite pixels must visibly cup the lower cheek in open and blink art`);
    }
  }
});

test('connected gestures enter, hold, and return through the authored drawings', () => {
  const state = director.create();
  director.select(state, catalog, 'wave', false, true);
  assert.deepEqual(Array.from({ length: 9 }, () => tick(state)), [1, 2, 3, 3, 3, 2, 1, 0, 0]);
  assert.equal(state.stage, 'idle');
});

test('Witty held blinks follow the visible eye and retain authored closed-eye blush', async t => {
  const sourcePath='artwork/avatars/witty/registration.json';
  if(!existsSync(sourcePath)){t.skip('local authoring landmarks are optional');return;}
  const registration=JSON.parse(readFileSync(sourcePath,'utf8'));
  const rig=JSON.parse(readFileSync('assets/witty-surface-rig.json','utf8'));
  const {data,info}=await sharp('assets/witty-surface.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  for(const [name,route] of Object.entries<any>(rig.surfaceSequences.routes)){
    const authored=registration.routes[name].frames;
    assert.equal(authored.length,16);
    for(const pose of authored)assert.equal(pose.landmarks.length,1, 'the X is not an eye landmark');
    for(const n of name==='shy'?[6,15]:[15]){
      const pose=authored[n],eye=pose.landmarks[0];
      const ex=eye.x*pose.scaleX+pose.tx,ey=eye.y*pose.scaleY+pose.ty;
      const frame=rig.parts[0].surfaceFrames[route.frames[6+n*3]-1];
      const [x,y,w,h]=frame.sourceRect,[bx,by]=frame.blinkSourceRect;
      let changes=0;
      for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
        const a=((y+yy)*info.width+x+xx)*4,b=((by+yy)*info.width+bx+xx)*4;
        if([0,1,2].some(c=>data[a+c]!==data[b+c])){
          const [scale, turn, dx, dy] = pose.bodyRegistration?.head || [1,0,0,0];
          const sx=scale*xx-turn*yy+dx,sy=turn*xx+scale*yy+dy;
          assert.ok(Math.hypot((sx-ex)/18,(sy-ey+2)/14)<1.1, name+': blink stays on the registered visible eye');
          changes++;
        }
      }
      if(pose.authoredClosed)assert.equal(changes,0,'strong blush keeps its authored eyelid and cheeks');
      else assert.ok(changes>100,name+': visible eye actually closes');
    }
  }
});

test('reviewed held eyelids close at the actual eyes and preserve already-closed expressions', async t => {
  const configs=Object.fromEntries(avatarCatalog.map(entry=>[entry.id,entry.authoring]));
  let checked=0,avatars=0;
  for(const [id,cfg] of Object.entries<any>(configs)){
    if(!cfg.heldEyes)continue;
    avatars++;
    const rig=JSON.parse(readFileSync(`assets/${id}-surface-rig.json`,'utf8'));
    const {data,info}=await sharp(`assets/${id}-surface.png`).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    for(const [key,spec]of Object.entries<any>(cfg.heldEyes)){
      const route=rig.surfaceSequences.routes[key==='shyHover'?'shy':key];
      const frame=rig.parts[0].surfaceFrames[(key==='shyHover'?route.frames[24]:route.frames.at(-1))-1];
      const [x,y,w,h]=frame.sourceRect,[bx,by]=frame.blinkSourceRect;
      const eyes=(spec.eyes||[]).map((eye:number[]|null)=>{
        if(!eye)return null;
        const angle=eye[4]*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
        return {x:eye[0]*w+2*sin,y:eye[1]*h-2*cos,rx:eye[2]*w,ry:eye[3]*h,cos,sin};
      });
      const changes=eyes.map(()=>0);
      for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
        const a=((y+yy)*info.width+x+xx)*4,b=((by+yy)*info.width+bx+xx)*4;
        assert.equal(data[a+3],data[b+3],`${id}/${key}: blink preserves exact alpha`);
        if([0,1,2].some(c=>data[a+c]!==data[b+c])){
          assert.notEqual(spec.closed,true,`${id}/${key}: authored closed eyes remain exact`);
          const owner=eyes.findIndex((eye:any)=>{
            if(!eye)return false;
            const dx=xx-eye.x,dy=yy-eye.y;
            return Math.hypot((eye.cos*dx+eye.sin*dy)/eye.rx,(-eye.sin*dx+eye.cos*dy)/eye.ry)<1.00001;
          });
          assert.ok(owner>=0,`${id}/${key}: displaced cheek, hair or mouth pixels must not change`);
          changes[owner]++;
        }
      }
      for(let i=0;i<eyes.length;i++)if(eyes[i])assert.ok(changes[i]>100,`${id}/${key}/${i}: the actual visible eye closes`);
      checked++;
    }
  }
  assert.equal(avatars,14,'all reviewed avatars retain their eye landmarks');
  assert.equal(checked,79,'all reviewed held poses retain their eye landmarks');
});

test('Alia held blinks stay on both registered eyes through full-body registration', async t => {
  const sourcePath='artwork/avatars/alia/registration.json';
  if(!existsSync(sourcePath)){t.skip('local authoring landmarks are optional');return;}
  const registration=JSON.parse(readFileSync(sourcePath,'utf8'));
  const rig=JSON.parse(readFileSync('assets/alia-surface-rig.json','utf8'));
  const {data,info}=await sharp('assets/alia-surface.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  for(const [name,route] of Object.entries<any>(rig.surfaceSequences.routes)){
    const authored=registration.routes[name].frames;
    assert.equal(authored.length,16);
    for(const pose of authored)assert.equal(pose.landmarks.length,2, name+': both eyes are explicitly registered');
    for(const n of name==='shy'?[6,15]:[15]){
      const pose=authored[n],changed=[0,0];
      const eyes=pose.landmarks.map((eye:any)=>({x:eye.x*pose.scaleX+pose.tx,y:eye.y*pose.scaleY+pose.ty}));
      const frame=rig.parts[0].surfaceFrames[route.frames[6+n*3]-1];
      const [x,y,w,h]=frame.sourceRect,[bx,by]=frame.blinkSourceRect;
      for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
        const a=((y+yy)*info.width+x+xx)*4,b=((by+yy)*info.width+bx+xx)*4;
        if([0,1,2].some(c=>data[a+c]!==data[b+c])){
          const [scale,turn,dx,dy]=pose.bodyRegistration?.head||[1,0,0,0];
          const sx=scale*xx-turn*yy+dx,sy=turn*xx+scale*yy+dy;
          const eye=eyes.findIndex((e:any)=>Math.hypot((sx-e.x)/18,(sy-e.y+2)/14)<1.1);
          assert.ok(eye>=0,name+': eyelid changes stay on the registered eyes');
          changed[eye]++;
        }
      }
      for(const count of changed)assert.ok(count>100,name+': each eye actually closes');
    }
  }
});

test('interrupted gestures reverse without a cut and the latest request wins', () => {
  const state = director.create();
  director.select(state, catalog, 'wave', false, true);
  tick(state); tick(state);
  director.select(state, catalog, 'thinking', true, true);
  assert.equal(tick(state, 0), 2);
  assert.equal(tick(state), 1);
  director.select(state, catalog, 'explainOpen', false, true);
  assert.deepEqual(Array.from({ length: 4 }, () => tick(state)), [0, 7, 8, 9]);
  assert.equal(state.route, 'open');
});

test('looping poses remain held until interrupted, and disabling always restores neutral', () => {
  const state = director.create();
  director.select(state, catalog, 'thinking', true, true);
  for (let i = 0; i < 300; i++) tick(state);
  assert.equal(state.frame, 6);
  director.select(state, catalog, 'idle', true, true);
  assert.deepEqual(Array.from({ length: 3 }, () => tick(state)), [5, 4, 0]);
  director.select(state, catalog, 'wave', false, true); tick(state);
  assert.equal(director.sample(state, 10, false), 0);
  assert.equal(state.stage, 'idle');
  assert.equal(tick(state), 0);
});

test('source changes reset frame IDs and invalid or suspended clocks stay bounded', () => {
  const state = director.create();
  director.select(state, catalog, 'wave', false, true); tick(state);
  const replacement = { routes: {}, motions: {} };
  director.select(state, replacement, 'wave', false, true);
  assert.equal(state.frame, 0);
  director.select(state, catalog, 'thinking', true, true);
  assert.equal(tick(state, NaN), 0);
  assert.equal(tick(state, -1), 0);
  assert.equal(tick(state, 20), 6);
  assert.equal(state.elapsed, 0);
});

test('hover strengthens on click and settles back without crossing neutral', () => {
  const c = {routes:{shy:{frames:[0,1,2,3,4,5,6],frameMs:20,holdMs:40}},motions:{hoverBlush:'shy',clickBlush:'shy'}};
  const state=director.create();
  director.select(state,c,'hoverBlush',true,true,.5);
  for(let i=0;i<20;i++)tick(state);
  assert.equal(state.frame,3);
  director.select(state,c,'clickBlush',true,true,1);
  assert.equal(tick(state,0),3);
  assert.deepEqual(Array.from({length:3},()=>tick(state)),[4,5,6]);
  director.select(state,c,'hoverBlush',true,true,.5);
  assert.deepEqual(Array.from({length:5},()=>tick(state)),[5,4,3,3,3]);
  director.select(state,c,'idle',true,true);
  assert.deepEqual(Array.from({length:3},()=>tick(state)),[2,1,0]);
});

test('carried poses continuously reverse their flail cycle and retrace on release', () => {
  const c={routes:{carry:{frames:[0,1,2,3,4,5],frameMs:20,loopMode:'pingPong',loopStart:2}},motions:{dragging:'carry'}};
  const state=director.create();director.select(state,c,'dragging',true,true);
  assert.deepEqual(Array.from({length:12},()=>tick(state)),[1,2,3,4,5,4,3,2,3,4,5,4]);
  director.select(state,c,'idle',true,true);
  assert.deepEqual(Array.from({length:4},()=>tick(state)),[3,2,1,0]);
  director.select(state,c,'dragging',true,true);tick(state);
  assert.equal(director.sample(state,.02,false),0);
});

test('every catalog clip and every route interruption restore neutral without stale frames', () => {
  const avatars=JSON.parse(readFileSync('assets/avatars.json','utf8'));
  const clips=JSON.parse(readFileSync('assets/motions.json','utf8')).clips;
  for(const avatar of avatars){
    const c=JSON.parse(readFileSync('assets/'+avatar.rig,'utf8')).surfaceSequences;
    if (!c) continue;
    const names=Object.keys(c.routes);
    const illustrated=['wave','greeting','goodbye','thinking','ponder','curious','skeptical','explainOpen','explainSweep','speaking','listen','approval','celebrate','success','fistPump','shy','hoverBlush','clickBlush','dragging'];
    assert.deepEqual(Object.keys(clips).filter(name=>c.motions[name]).sort(),illustrated.sort(),avatar.id+': explicit illustrated-gesture coverage');
    for(const [name,clip] of Object.entries<any>(clips)){
      const state=director.create();
      assert.equal(state.frame,0,avatar.id+'/'+name+': starts neutral');
      director.select(state,c,name,clip.loop||clip.surfaceHold,true,clip.surfaceStrength);
      let illustratedFrames=0;
      for(let i=0;i<180;i++){
        const frame=tick(state,1/60);
        assert.ok(frame===0||c.routes[c.motions[name]].frames.includes(frame),avatar.id+'/'+name);
        if(frame)illustratedFrames++;
      }
      assert.equal(illustratedFrames>0,illustrated.includes(name),avatar.id+'/'+name+': full pose or secondary motion is deliberate');
      director.select(state,c,'idle',true,true);
      for(let i=0;i<60;i++)tick(state,1/60);
      assert.equal(state.frame,0,avatar.id+'/'+name+': no residual drawing');
      assert.equal(state.route,'');assert.equal(state.index,0);
    }
    for(const from of names)for(const to of names)for(const interruption of [1,24,51]){
      const motionFor=(route:string)=>Object.keys(c.motions).find(name=>c.motions[name]===route);
      const state=director.create();
      director.select(state,c,motionFor(from),true,true);
      for(let i=0;i<interruption;i++)tick(state,1/60);
      const prior=state.frame;
      director.select(state,c,motionFor(to),true,true);
      assert.equal(tick(state,0),prior,avatar.id+': interruption keeps the current drawing');
      for(let i=0;i<120;i++)tick(state,1/60);
      assert.equal(state.route,to,avatar.id+': latest route wins');
      assert.equal(director.sample(state,.02,false),0,avatar.id+': reduced motion clears every route');
      assert.equal(state.index,0);assert.equal(state.stage,'idle');
    }
  }
});

test('every manifest surface atlas preserves neutral art, planted gestures and free carried limbs', async t => {
  const avatars = JSON.parse(readFileSync('assets/avatars.json', 'utf8'));
  assert.ok(avatars.length > 0);
  for (const avatar of avatars) {
    const rig = JSON.parse(readFileSync('assets/' + avatar.rig, 'utf8'));
    const part = rig.parts[0];
    const {data, info} = await sharp('assets/' + rig.texture).raw().toBuffer({resolveWithObject: true});
    if (avatar.id === 'pal') {
      assert.equal(avatar.default, true, 'PAL remains the default avatar');
      assert.notEqual(rig.static, true, 'the default PAL participates in the complete gesture and blink suite');
    }
    if (rig.static) {
      assert.equal(rig.presentation, 'reference');
      assert.equal(part.surfaceMotion, false);
      assert.deepEqual(part.sourceRect, [0, 0, info.width, info.height]);
      assert.ok(info.width * info.height * 4 <= 256 * 1024 * 1024, 'static artwork stays within Qt image allocation limit');
      continue;
    }
    const sourceDir = 'artwork/avatars/' + avatar.id;
    if (avatar.id === 'pal') {
      assert.deepEqual(part.sourceRect, [0, 0, 1024, 1024], 'PAL keeps its exact full-size neutral tile');
      for (const [index, frame] of part.surfaceFrames.entries())
        assert.deepEqual(frame.sourceRect.slice(2), [400, 400], `pal/frame-${index + 1}: fixed gesture-cell dimensions`);
      const reference = await sharp('reference/pal-front.png').ensureAlpha().raw().toBuffer({resolveWithObject: true});
      assert.deepEqual([reference.info.width, reference.info.height], [1024, 1024], 'tracked PAL neutral dimensions');
      for (let y = 0; y < 1024; y++) {
        const atlasStart = ((part.sourceRect[1] + y) * info.width + part.sourceRect[0]) * 4;
        assert.deepEqual(data.subarray(atlasStart, atlasStart + 1024 * 4),
          reference.data.subarray(y * 1024 * 4, (y + 1) * 1024 * 4), `pal/neutral row ${y}: exact tracked pixels`);
      }
    }
    await t.test(avatar.id + ': exact visible neutral source pixels', {
      skip: !existsSync(sourceDir + '/registration.json') || !existsSync(sourceDir + '/front.png')
        ? 'authoring sources are optional; packed runtime art is checked below' : false
    }, async () => {
      const registration = JSON.parse(readFileSync(sourceDir + '/registration.json', 'utf8'));
      const original = await sharp(sourceDir + '/front.png').raw().toBuffer({resolveWithObject: true});
      const [ox, oy] = registration.originalOffset;
      for (let y = 0; y < original.info.height; y++) for (let x = 0; x < original.info.width; x++) {
        const source = (y * original.info.width + x) * 4;
        if (!original.data[source + 3]) continue;
        assert.ok(y + oy < part.sourceRect[3] && x + ox < part.sourceRect[2], avatar.id + ': neutral fits canvas');
        const target = ((y + oy) * info.width + ox + x) * 4;
        assert.deepEqual(data.subarray(target, target + 4), original.data.subarray(source, source + 4), avatar.id + ': exact visible neutral pixels');
      }
    });
    const [nx, ny, nw, nh] = part.sourceRect;
    const [, , frameWidth, frameHeight] = part.surfaceFrames[0].sourceRect;
    const neutral = await sharp(data, {raw:info}).extract({left:nx, top:ny, width:nw, height:nh})
      .resize(frameWidth, frameHeight).raw().toBuffer();
    let ground = -1;
    for (let p = 3; p < neutral.length; p += 4) if (neutral[p] > 180) ground = Math.floor(p / 4 / frameWidth);
    assert.deepEqual(Object.keys(rig.surfaceSequences.routes), ['wave', 'thinking', 'present', 'celebrate', 'shy', 'carry']);
    assert.equal(rig.surfaceSequences.motions.shy, 'shy');
    assert.equal(rig.surfaceSequences.motions.hoverBlush, 'shy');
    assert.equal(rig.surfaceSequences.motions.clickBlush, 'shy');
    assert.equal(rig.surfaceSequences.motions.dragging, 'carry');
    assert.equal(part.surfaceFrames.length, 306);
    assert.ok(info.width*info.height*4 <= 256*1024*1024, 'atlas stays within Qt image allocation limit');
    const hoverFrame=rig.surfaceSequences.routes.shy.frames[24];
    assert.ok(part.surfaceFrames[hoverFrame-1].blinkSourceRect, 'held hover pose can blink');
    const blinkChanges = (frame: any, label: string) => {
      const [x, y, w, h] = frame.sourceRect, [bx, by, bw, bh] = frame.blinkSourceRect;
      assert.deepEqual([bw, bh], [w, h], label + ': blink cell matches its open pose');
      assert.ok(bx >= 0 && by >= 0 && bx + bw <= info.width && by + bh <= info.height, label + ': blink cell fits atlas');
      let changed = 0;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const open = ((y + yy) * info.width + x + xx) * 4;
        const closed = ((by + yy) * info.width + bx + xx) * 4;
        assert.equal(data[open + 3], data[closed + 3], label + ': blinking preserves pose silhouette');
        if ([0, 1, 2].some(channel => data[open + channel] !== data[closed + channel])) changed++;
      }
      return changed;
    };
    for (const [index, frame] of [part, ...part.surfaceFrames].entries()) {
      if (frame.blinkSourceRect) blinkChanges(frame, `${avatar.id}/frame-${index}`);
    }
    if (avatar.id === 'pal') {
      assert.ok(part.blinkSourceRect, 'PAL neutral can blink');
      assert.ok(blinkChanges(part, 'pal/neutral') > 100, 'PAL neutral eyes visibly close');
      for (const [name, route] of Object.entries<any>(rig.surfaceSequences.routes)) {
        const endpoint = part.surfaceFrames[route.frames.at(-1) - 1];
        const changes = blinkChanges(endpoint, `pal/${name}/held`);
        if (avatar.authoring.heldEyes?.[name]?.closed) assert.equal(changes, 0, `pal/${name}: authored closed eyes remain exact`);
        else assert.ok(changes > 100, `pal/${name}: held eyes visibly close`);
      }
      const hover = part.surfaceFrames[rig.surfaceSequences.routes.shy.frames[24] - 1];
      const hoverChanges = blinkChanges(hover, 'pal/shyHover/held');
      if (avatar.authoring.heldEyes?.shyHover?.closed) assert.equal(hoverChanges, 0, 'pal/shyHover: authored closed eyes remain exact');
      else assert.ok(hoverChanges > 100, 'pal/shyHover: held eyes visibly close');
    }
    const rects = [part.sourceRect, ...part.surfaceFrames.map((frame: any) => frame.sourceRect)];
    // Use the top edge of the visible eye boxes, so expressions do not change
    // the sample. Measure the shipped textures even without the authoring PNGs.
    const cfg = avatar.authoring;
    const offsetY = cfg.originalOffset?.[1] ?? nh - 8 - (cfg.bounds[3] + 1);
    const eyeTop = Math.min(...cfg.eyes.map((box: number[]) => box[1]));
    const crownHeight = Math.floor((eyeTop - cfg.crop[1] + offsetY) * frameHeight / nh);
    const neutralColor = upperHeadColor(neutral, frameWidth, 0, 0, frameWidth, crownHeight);
    let avatarColorDrift = 0;
    for (const [name, route] of Object.entries<any>(rig.surfaceSequences.routes)) {
      assert.equal(route.frames[0], 0, avatar.id + '/' + name + ': neutral entry');
      assert.equal(route.frames.length, 52, avatar.id + '/' + name + ': neutral plus 51 prepared frames');
      assert.ok(route.frameMs <= 1000 / 60 + 1e-8);
      const endpoint = part.surfaceFrames[route.frames.at(-1) - 1];
      assert.ok(endpoint.blinkSourceRect, avatar.id + '/' + name + ': held pose blink');
      const baselines:number[]=[];
      let colorDrift = 0;
      for (const id of route.frames.slice(1)) {
        assert.ok(Number.isInteger(id) && rects[id]);
        const [x, y, w, h] = rects[id];
        const color = upperHeadColor(data, info.width, x, y, w, crownHeight);
        colorDrift += color.reduce((sum, channel, c) => sum + Math.abs(channel - neutralColor[c]), 0) / 3;
        let bottom = -1, edge = 0;
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
          const alpha = data[((y + yy) * info.width + x + xx) * 4 + 3];
          if (alpha > 180) { bottom = yy; if (xx === 0 || xx === w - 1 || yy === 0 || yy === h - 1) edge++; }
        }
        baselines.push(bottom);
        if(name!=='carry')assert.equal(bottom, ground, avatar.id + '/' + name + '/' + id + ': planted baseline');
        assert.equal(edge, 0, avatar.id + '/' + name + '/' + id + ': no clipped opaque edge');
      }
      // Allow highlights and composition to change as the head tilts, while
      // catching a sustained exposure or palette change across the route.
      const meanColorDrift = colorDrift / baselines.length;
      assert.ok(meanColorDrift < 8, `${avatar.id}/${name}: mean upper-head RGB drift ${meanColorDrift.toFixed(2)}/255`);
      avatarColorDrift += colorDrift;
      if(name==='carry'){
        assert.equal(route.loopMode,'pingPong');assert.ok(route.loopStart>0&&route.loopStart<route.frames.length-1);
        const suspended=baselines.slice(route.loopStart);
        assert.ok(Math.max(...suspended)-Math.min(...suspended)>3, avatar.id+': carried limbs are not pinned to the floor');
      }
    }
    const meanAvatarDrift = avatarColorDrift / part.surfaceFrames.length;
    assert.ok(meanAvatarDrift < 4, `${avatar.id}: mean upper-head RGB drift ${meanAvatarDrift.toFixed(2)}/255 across all gestures`);
  }
});
