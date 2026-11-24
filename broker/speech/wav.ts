export type WavInfo={sampleRate:number;channels:number;bitsPerSample:number;dataBytes:number;durationSeconds:number};
/** Parses the PCM facts PAL needs without decoding or trusting a fixed 44-byte header. */
export function wavInfo(wav:Buffer):WavInfo {
  if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw new Error('The hosted transcription service requires a WAV file up to 24 MiB');
  let format=0,sampleRate=0,channels=0,bitsPerSample=0,dataBytes=0;
  for(let offset=12;offset+8<=wav.length;){const size=wav.readUInt32LE(offset+4),at=offset+8;if(size>wav.length-at)throw new Error('The hosted transcription WAV is truncated');const id=wav.toString('ascii',offset,offset+4);
    if(id==='fmt '&&size>=16){format=wav.readUInt16LE(at);channels=wav.readUInt16LE(at+2);sampleRate=wav.readUInt32LE(at+4);bitsPerSample=wav.readUInt16LE(at+14);}
    if(id==='data')dataBytes+=size;offset=at+size+(size%2);
  }
  if(format!==1||![1,2].includes(channels)||![8,16,24,32].includes(bitsPerSample)||sampleRate<8000||sampleRate>96000||!dataBytes)throw new Error('The hosted transcription service requires uncompressed PCM WAV audio');
  const bytesPerSecond=sampleRate*channels*bitsPerSample/8;
  return{sampleRate,channels,bitsPerSample,dataBytes,durationSeconds:dataBytes/bytesPerSecond};
}
