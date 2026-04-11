-- AlterTable
ALTER TABLE "Store" ADD COLUMN "shopDomain" TEXT,
                    ADD COLUMN "accessToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Store_shopDomain_key" ON "Store"("shopDomain");
