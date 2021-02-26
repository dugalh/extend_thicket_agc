// Functions for cloud and shadow masking Sentinel-2 and Landsat 8 imagery

// Simple Sentinel-2 cloud masking using QA60 band
function s2_simple_cloud_mask(image) 
{
  var qa = image.select('QA60');
  var bitMask = (1 << 11) | (1 << 10);
  return image.updateMask(qa.bitwiseAnd(bitMask).eq(0).focal_min(10));
}
exports.s2_simple_cloud_mask = s2_simple_cloud_mask;

// Cloud mask Landsatr with the GEE simpleCloudScore function
function landsat_simple_cloud_mask(image, thresh=5)
{
  var scored = ee.Algorithms.Landsat.simpleCloudScore(image);
  var mask = scored.select(['cloud']).lte(thresh);
  return image.updateMask(mask);
}

// Cloud and shadow mask L8 SR data with "pixel_qa" band
function landsat8_sr_cloud_mask(image) 
{
  // Bits 3 and 5 are cloud shadow and cloud, respectively.
  var mask_bit = (1 << 5) | (1 << 3);
  var qa = image.select('pixel_qa');
  return image.updateMask(qa.bitwiseAnd(mask_bit).eq(0));
}

// Cloud and shadow mask L8 TOA data with "BQA" band
function landsat8_toa_cloud_mask(image) 
{
  // Bits 3 and 5 are cloud shadow and cloud, respectively.
  // var could_shadow_bit = (1 << 3);
  // var cloud_bit = (1 << 4);
  var bit_mask = (1 << 4) | (1 << 8);    // cloud bit and upper bit of shadow confidence
  // Get the pixel QA band.
  var qa = image.select('BQA');
  // Both flags should be set to zero, indicating clear conditions.
  var mask = qa.bitwiseAnd(bit_mask).eq(0);
  return image.updateMask(mask);
}