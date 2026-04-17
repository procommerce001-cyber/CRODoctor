-- CreateEnum
CREATE TYPE "SetupStatus" AS ENUM ('PENDING', 'SYNCING', 'COMPLETED');

-- AlterTable: Store
ALTER TABLE "Store"
    ADD COLUMN "shopUrl"     TEXT,
    ADD COLUMN "setupStatus" "SetupStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable: User
CREATE TABLE "User" (
    "id"        TEXT         NOT NULL,
    "email"     TEXT         NOT NULL,
    "storeId"   TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
