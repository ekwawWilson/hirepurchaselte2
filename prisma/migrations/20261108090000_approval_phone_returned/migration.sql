-- A phone sale's cancel or write-off waiting for a second approval: whether the phone was taken back.
ALTER TABLE "approval_requests" ADD COLUMN "phoneReturned" BOOLEAN;
