CREATE TABLE ext_pro_resend_callbacks(id TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE ext_pro_aws_tests(id TEXT PRIMARY KEY, actor TEXT NOT NULL, brand TEXT NOT NULL, created BIGINT NOT NULL, result TEXT);
INSERT INTO ext_pro_resend_callbacks VALUES('old-callback','accepted');
INSERT INTO ext_pro_aws_tests VALUES('old-test','demo','acme',1,'retained');
