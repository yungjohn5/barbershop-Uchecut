-- Images move to Cloudinary. Old local paths are kept (renamed to legacy*Path, nullable)
-- until scripts/upload-local-images.js uploads them and clears the column; a later
-- migration drops the legacy columns once they are empty everywhere.

-- Service
ALTER TABLE "Service" RENAME COLUMN "imageUrl" TO "legacyImagePath";
ALTER TABLE "Service"
  ADD COLUMN "imagePublicId" TEXT,
  ADD COLUMN "imageVersion" INTEGER,
  ADD COLUMN "imageWidth" INTEGER,
  ADD COLUMN "imageHeight" INTEGER;

-- Barber
ALTER TABLE "Barber" RENAME COLUMN "photoUrl" TO "legacyPhotoPath";
ALTER TABLE "Barber"
  ADD COLUMN "photoPublicId" TEXT,
  ADD COLUMN "photoVersion" INTEGER,
  ADD COLUMN "photoWidth" INTEGER,
  ADD COLUMN "photoHeight" INTEGER;

-- Product
ALTER TABLE "Product" RENAME COLUMN "imageUrl" TO "legacyImagePath";
ALTER TABLE "Product"
  ADD COLUMN "imagePublicId" TEXT,
  ADD COLUMN "imageVersion" INTEGER,
  ADD COLUMN "imageWidth" INTEGER,
  ADD COLUMN "imageHeight" INTEGER;

-- GalleryItem (image was required; legacy path becomes optional)
ALTER TABLE "GalleryItem" RENAME COLUMN "imageUrl" TO "legacyImagePath";
ALTER TABLE "GalleryItem" ALTER COLUMN "legacyImagePath" DROP NOT NULL;
ALTER TABLE "GalleryItem"
  ADD COLUMN "imagePublicId" TEXT,
  ADD COLUMN "imageVersion" INTEGER,
  ADD COLUMN "imageWidth" INTEGER,
  ADD COLUMN "imageHeight" INTEGER;
