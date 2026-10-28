"""Offline regressions for the shared Chrome slot journal parser."""
import unittest
from slot_queue import read_queue


class SlotQueueTest(unittest.TestCase):
    def state(self, *lines):
        return read_queue(lines)

    def test_withdrawal_is_not_a_new_request(self):
        self.assertEqual(self.state('old A KOLEJKA t', 'old A KOLEJKA WYCOFANA t',
                                    'mailstack EXP-1 KOLEJKA t'),
                         (None, [('mailstack', 'EXP-1')]))

    def test_short_withdrawal_retires_request(self):
        self.assertEqual(self.state('sellf W101 KOLEJKA t',
                                    'sellf W101 WYCOFANA t',
                                    'mailstack EXP-1 KOLEJKA t'),
                         (None, [('mailstack', 'EXP-1')]))

    def test_info_release_retires_an_unstarted_request(self):
        self.assertEqual(self.state('old A KOLEJKA t',
                                    'old A INFO t — slot zwolniony, Chrome closed'),
                         (None, []))

    def test_info_timestamp_release_clears_its_owner(self):
        self.assertEqual(self.state('old A START t',
                                    'old A INFO t — finalny slot zwolniony08:14:41Z, offline'),
                         (None, []))

    def test_future_release_is_not_a_release(self):
        self.assertEqual(self.state('old A START t',
                                    'old A INFO t — czekam na SLOT ZWOLNIONY B; potem start',
                                    'old A INFO t — trwa bieg; finalne zwolnienie osobną linią'),
                         (('old', 'A'), []))

    def test_new_request_moves_session_to_the_back(self):
        self.assertEqual(self.state('old A KOLEJKA t', 'next B KOLEJKA t',
                                    'old A KOLEJKA t'),
                         (None, [('next', 'B'), ('old', 'A')]))

    def test_other_projects_release_does_not_clear_current_owner(self):
        self.assertEqual(self.state('current A START t', 'old B SLOT ZWOLNIONY t'),
                         (('current', 'A'), []))

    def test_all_projects_have_equal_priority(self):
        self.assertEqual(self.state('mailstack EXP-2 KOLEJKA t',
                                    'mailstack EXP-1 KOLEJKA t'),
                         (None, [('mailstack', 'EXP-2'), ('mailstack', 'EXP-1')]))

    def test_start_consumes_request_and_next_run_is_new(self):
        self.assertEqual(self.state('old A KOLEJKA t', 'old A START t',
                                    'old A SLOT ZWOLNIONY t', 'next B KOLEJKA t',
                                    'old A KOLEJKA t'),
                         (None, [('next', 'B'), ('old', 'A')]))

    def test_session_prefix_and_vm_lines_do_not_match(self):
        self.assertEqual(self.state('old A KOLEJKA t', 'old AB START t',
                                    'recast MT3 VM KONIEC t'),
                         (('old', 'AB'), [('old', 'A')]))


if __name__ == '__main__':
    unittest.main()
