require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function testQuery() {
  console.log("Testing pending query...");
  const pending = await supabase
    .from('collection_correction_requests')
    .select(`*, requester:users!requested_by(id, full_name)`)
    .eq('status', 'pending_owner')
    .order('created_at', { ascending: false });
  console.log("Pending error:", pending.error);

  console.log("Testing approved query...");
  const approved = await supabase
    .from('collection_correction_requests')
    .select(`*, requester:users!requested_by(id, full_name)`)
    .eq('status', 'approved')
    .order('owner_reviewed_at', { ascending: false });
  console.log("Approved error:", approved.error);
}

testQuery();
