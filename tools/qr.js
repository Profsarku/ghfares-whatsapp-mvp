/**
 * Minimal QR encoder (byte mode, EC level M) — enough for short URLs.
 * Keeps the landing page dependency-free.
 */
const G15 = 0x537, G18 = 0x1f25, G15_MASK = 0x5412;
function bch(d, poly, deg){let dd=d<<deg;while(bitLen(dd)-bitLen(poly)>=0)dd^=poly<<(bitLen(dd)-bitLen(poly));return (d<<deg)|dd;}
function bitLen(n){let l=0;while(n!==0){l++;n>>>=1;}return l;}
const EXP=new Array(256),LOG=new Array(256);
(function(){let x=1;for(let i=0;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&0x100)x^=0x11d;}EXP[255]=EXP[0];})();
const gmul=(a,b)=>(a===0||b===0)?0:EXP[(LOG[a]+LOG[b])%255];
function rsPoly(deg){let p=[1];for(let i=0;i<deg;i++){const n=new Array(p.length+1).fill(0);
  for(let j=0;j<p.length;j++){n[j]^=gmul(p[j],1);n[j+1]^=gmul(p[j],EXP[i]);}p=n;}return p;}
function rsEncode(data,deg){const gen=rsPoly(deg);const res=new Array(deg).fill(0);
  for(const b of data){const f=b^res[0];res.shift();res.push(0);
    for(let i=0;i<deg;i++)res[i]^=gmul(gen[i+1],f);}return res;}

// version 4 (33x33), EC M: 64 data codewords, 18 EC — comfortably fits our URLs
const VER=4,SIZE=33,DATA_CW=64,EC_CW=18;

function encode(text){
  const bytes=[...Buffer.from(text,'utf8')];
  if(bytes.length>DATA_CW-3) throw new Error('URL too long for version 4');
  const bits=[];
  const push=(v,n)=>{for(let i=n-1;i>=0;i--)bits.push((v>>>i)&1);};
  push(4,4); push(bytes.length,8);
  bytes.forEach(b=>push(b,8));
  push(0,Math.min(4,DATA_CW*8-bits.length));
  while(bits.length%8) bits.push(0);
  const cw=[]; for(let i=0;i<bits.length;i+=8){let v=0;for(let j=0;j<8;j++)v=(v<<1)|bits[i+j];cw.push(v);}
  const pad=[0xEC,0x11]; let k=0;
  while(cw.length<DATA_CW) cw.push(pad[k++%2]);
  return cw.concat(rsEncode(cw,EC_CW));
}

function matrix(text){
  const m=Array.from({length:SIZE},()=>new Array(SIZE).fill(null));
  const set=(r,c,v)=>{if(r>=0&&r<SIZE&&c>=0&&c<SIZE)m[r][c]=v;};
  const finder=(r,c)=>{for(let i=-1;i<=7;i++)for(let j=-1;j<=7;j++){
    const rr=r+i,cc=c+j; if(rr<0||rr>=SIZE||cc<0||cc>=SIZE)continue;
    const on=(i>=0&&i<=6&&(j===0||j===6))||(j>=0&&j<=6&&(i===0||i===6))||(i>=2&&i<=4&&j>=2&&j<=4);
    set(rr,cc,on?1:0);}};
  finder(0,0);finder(0,SIZE-7);finder(SIZE-7,0);
  // alignment pattern for v4 at (26,26)
  for(let i=-2;i<=2;i++)for(let j=-2;j<=2;j++)
    set(26+i,26+j,(Math.max(Math.abs(i),Math.abs(j))!==1)?1:0);
  for(let i=8;i<SIZE-8;i++){const v=(i%2===0)?1:0;set(6,i,v);set(i,6,v);}
  set(SIZE-8,8,1);
  // reserve format areas
  const fmtCells=[];
  for(let i=0;i<9;i++){if(m[8][i]===null){fmtCells.push([8,i]);m[8][i]=0;} if(m[i][8]===null){fmtCells.push([i,8]);m[i][8]=0;}}
  for(let i=SIZE-8;i<SIZE;i++){if(m[8][i]===null){m[8][i]=0;} if(m[i][8]===null){m[i][8]=0;}}

  const cw=encode(text);
  const bits=[]; cw.forEach(b=>{for(let i=7;i>=0;i--)bits.push((b>>>i)&1);});
  let bi=0,up=true;
  for(let col=SIZE-1;col>0;col-=2){
    if(col===6)col--;
    for(let n=0;n<SIZE;n++){
      const row=up?SIZE-1-n:n;
      for(let c=0;c<2;c++){
        const cc=col-c;
        if(m[row][cc]!==null)continue;
        let bit=bi<bits.length?bits[bi++]:0;
        if(((row+cc)%2)===0) bit^=1;          // mask 0
        m[row][cc]=bit;
      }
    }
    up=!up;
  }
  // format info: EC M (01) + mask 0 → 0b00000
  const fmt=bch(0b00<<3|0,G15,10)^G15_MASK;
  const fbits=[];for(let i=14;i>=0;i--)fbits.push((fmt>>>i)&1);
  const put=(r,c,v)=>{m[r][c]=v;};
  const a=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  a.forEach(([r,c],i)=>put(r,c,fbits[14-i]));
  const b=[[SIZE-1,8],[SIZE-2,8],[SIZE-3,8],[SIZE-4,8],[SIZE-5,8],[SIZE-6,8],[SIZE-7,8],
           [8,SIZE-8],[8,SIZE-7],[8,SIZE-6],[8,SIZE-5],[8,SIZE-4],[8,SIZE-3],[8,SIZE-2],[8,SIZE-1]];
  b.forEach(([r,c],i)=>put(r,c,fbits[i]));
  return m.map(row=>row.map(v=>v?1:0));
}
module.exports={matrix};
