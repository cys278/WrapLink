-- Durable source of short-code ID blocks for the write-behind creation path.
--
-- Each nextval() reserves INCREMENT_BY consecutive IDs for one process.
-- The allocator reads increment_by from pg_sequences at reservation time,
-- so the block size is defined here and only here.
--
-- A PostgreSQL sequence is used instead of a Redis counter because Redis is
-- treated as a cache: if a Redis counter were lost or restored from an old
-- snapshot, previously issued IDs (and therefore codes) would be reissued.
CREATE SEQUENCE link_code_block_seq
  AS BIGINT
  START WITH 0
  MINVALUE 0
  INCREMENT BY 10000
  NO CYCLE;
