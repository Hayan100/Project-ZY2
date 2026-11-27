import {PDFDocument} from "pdf-lib";
import sharp from "sharp";
import {fail} from "./authorized.ts";

// Only the authorized single page may be returned by the page adapter.
export async function stampPage(input:Buffer,svg:string) {
  const pdf=input.subarray(0,5).toString()==="%PDF-"?await PDFDocument.load(input):null;
  if(pdf && pdf.getPageCount()!==1)fail(503);
  const page=pdf?.getPage(0);
  const box=page?.getCropBox();
  const raster=sharp(input,{limitInputPixels:16_000_000});
  const size=box??await raster.metadata();
  if(!size.width || !size.height || size.width*size.height>16_000_000)fail(503);
  const overlay=Buffer.from(svg.replace('width="100%" height="100%"',`width="${Math.ceil(size.width)}" height="${Math.ceil(size.height)}"`));
  if(pdf && page && box){
    const image=await pdf.embedPng(await sharp(overlay).png().toBuffer());
    page.drawImage(image,box);
    return {type:"application/pdf",bytes:Buffer.from(await pdf.save())};
  }
  return {type:"image/png",bytes:await raster.composite([{input:overlay}]).png().toBuffer()};
}
export async function readPage(response:Response){
  const reader=response.body?.getReader();
  if(!response.ok || !reader)fail(503);
  const chunks:Uint8Array[]=[];
  let length=0;
  for(;;){
    const {value,done}=await reader.read();
    if(done)break;
    length+=value.byteLength;
    if(length>32*1024*1024){await reader.cancel();fail(503)}
    chunks.push(value);
  }
  return Buffer.concat(chunks,length);
}
