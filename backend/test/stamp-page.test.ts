import test from "node:test";
import assert from "node:assert/strict";
import {PDFDocument,PDFName,PDFDict} from "pdf-lib";
import sharp from "sharp";
import {pdfStamp} from "../src/media-watermark.ts";
import {stampPage} from "../src/stamp-page.ts";

test("student stamp paints repeated diagonal text into real PDF and raster pages",async()=>{
  const {svg,label}=pdfStamp({name:"Alex & Lee",phone:"+923001234567",email:"reader@example.test"});
  assert.equal(label,"Alex & Lee · +923001234567 · reader@example.test");
  assert.ok(svg.includes("Alex &amp; Lee"));
  const input=await PDFDocument.create();
  input.addPage([720,960]).drawText("Sample lesson");
  const output=await stampPage(Buffer.from(await input.save()),svg);
  assert.equal(output.type,"application/pdf");
  const saved=await PDFDocument.load(output.bytes);
  const images=saved.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"),PDFDict);
  assert.ok(images?.keys().length);
  const white=await sharp({create:{width:720,height:960,channels:3,background:"white"}}).png().toBuffer();
  const raster=await stampPage(white,svg);
  const stats=await sharp(raster.bytes).stats();
  assert.ok(stats.channels[0].min<250 && stats.channels[0].max===255);
  input.addPage();
  await assert.rejects(stampPage(Buffer.from(await input.save()),svg));
});
